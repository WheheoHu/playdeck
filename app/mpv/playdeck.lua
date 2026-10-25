-- PlayDeck's playback OSD: a gamepad-first overlay for mpv (docs/DESIGN.md, section 7.3).
--
-- The host starts mpv idle with `--script-opts=playdeck-session=<file>`. The session file holds one
-- video (shared/bridge.ts, PlaySession) including the Plex token in its HTTP headers, so this script
-- reads it and deletes it at once. Later videos (the next episode) arrive the same way through
-- `script-message-to playdeck load <file>`. Key bindings come from the generated input.conf, which
-- binds keys to the named bindings below (`script-binding playdeck/confirm` and so on).
--
-- Events for the UI go out as `script-message playdeck-event <json>`, which the host reads over IPC.

local utils = require 'mp.utils'
local msg = require 'mp.msg'

local FONT = 'Noto Sans CJK SC'
-- libass sizes a font by its whole line height, which for Noto Sans CJK is 1.448 em; sizes below are
-- CSS pixels, as in the UI.
local FONT_SCALE = 1.448
local HEIGHT = 800 -- script units; the width follows the window's aspect
local MARGIN = 48
local HINTS_HEIGHT = 44

local HIDE_AFTER = 4
local HOLD_DELAY = 0.35
local HOLD_INTERVAL = 0.12
-- A scrub becomes one seek this long after the last step, so holding the D-pad does not flood a slow
-- server with seeks.
local SCRUB_SETTLE = 0.3
local NEXT_COUNTDOWN = 10
-- Without a credits marker, the next-episode card appears this long before the end.
local NEXT_LEAD = 10
local NEXT_TIMEOUT = 30
local TOAST_TIME = 2
-- B stops playback when pressed again within this many seconds.
local STOP_WINDOW = 2
local TICK = 0.25
-- The network panel samples mpv's read rate once a second and graphs the last minute.
local SAMPLE_INTERVAL = 1
local SAMPLES = 60

-- ASS colors are BGR; alpha 00 is opaque.
local TEXT, MUTED, ACCENT, WARN = 'F5F2F2', 'A69A9A', '0DA0E5', '6B6BF0'
local GREEN, TEAL, PURPLE = '8DD36F', 'C2C85C', 'F09CA9'
local SURFACE, BAR_BG, BLACK = '1D1717', '0F0B0B', '000000'
local GLYPH, GLYPH_TEXT, GLYPH_ALPHA = 'F5F2F2', '111111', '14'

local SPEEDS = { 0.5, 0.75, 1, 1.25, 1.5, 2 }
local STATS_ORDER = { 'video', 'timing', 'audio', 'network', 'scope' }
local scope_layout

local session
local run_dir = '/tmp'
local scope_shader_path
local scope_seq = 0
local last_shader_sig = ''
local final_credits -- the last credits marker, where the next-episode card appears
local mapped = {} -- session track id -> mpv track id
local loading_next = false
local next_timer

local state = {
  osd = false,
  stats = false,
  menu = nil,
  toast = nil,
  scrub = nil,
  prompt = nil, -- index of the marker whose skip button is shown
  dismissed = {},
  skipped = {},
  next_card = nil, -- { remaining = seconds or nil without autoplay }
  next_cancelled = false,
  stop_armed = false, -- B was pressed once; again within STOP_WINDOW stops
  stop_releasing = false, -- second B is held; quit fires on key-up so B is not down during handoff
}

local stats_sections = nil -- map of section -> bool, initialized from first session

-- Read rates in bits/s, false while the cache was not reading (full, or the whole file is in).
local net = { on = nil, samples = {}, sum = 0, count = 0, rate = nil, last = nil, ahead = 0, bytes = 0, idle = false, eof = false }

local props = { pos = nil, duration = nil, paused = true, buffering = false, cache = 0, eof = false }
local res_x, res_y = 1280, HEIGHT
local hide_timer, toast_timer, scrub_timer, stop_timer

local shade = mp.create_osd_overlay('ass-events')
local main = mp.create_osd_overlay('ass-events')
local measurer = mp.create_osd_overlay('ass-events')
local pulse = mp.create_osd_overlay('ass-events')
local pulse_tick = false
local curtain = false
shade.z, main.z, pulse.z = 0, 1, 10
measurer.hidden, measurer.compute_bounds = true, true

local function show_curtain()
  if not curtain then
    curtain = true
    mp.set_property_bool('sub-visibility', false)
  end
  pulse_tick = not pulse_tick
  pulse.res_x, pulse.res_y = res_x, res_y
  pulse.data = string.format(
    '{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H000000&\\1a&H00&\\p1}m -200 -200 l 4000 -200 l 4000 2000 l -200 2000{\\p0}\n'
      .. '{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H010101&\\1a&H%s&\\p1}m 0 0 l 1 0 l 1 1 l 0 1{\\p0}',
    pulse_tick and 'FE' or 'FD')
  pulse:update()
end

local function hide_curtain()
  if not curtain then return end
  curtain = false
  pulse.data = ''
  pulse:update()
  mp.set_property_bool('sub-visibility', true)
end

-- Text and strings ---------------------------------------------------------------------------------

local function S(key, params)
  local text = session and session.strings and session.strings[key] or key
  if params then
    text = text:gsub('{(%w+)}', function(name)
      local value = params[name]
      return value ~= nil and tostring(value) or nil
    end)
  end
  return text
end

local function clock(seconds)
  seconds = math.max(0, math.floor(seconds or 0))
  local h, m, s = math.floor(seconds / 3600), math.floor(seconds % 3600 / 60), seconds % 60
  if h > 0 then return string.format('%d:%02d:%02d', h, m, s) end
  return string.format('%d:%02d', m, s)
end

local function rate_text(bits)
  if bits >= 1e8 then return string.format('%.0f Mbps', bits / 1e6) end
  if bits >= 1e6 then return string.format('%.1f Mbps', bits / 1e6) end
  return string.format('%.0f kbps', bits / 1e3)
end

local function size_text(bytes)
  if bytes >= 1e9 then return string.format('%.1f GB', bytes / 1e9) end
  return string.format('%.0f MB', bytes / 1e6)
end

local function esc(text)
  return (tostring(text):gsub('\\', '\\\239\187\191'):gsub('{', '\\{'):gsub('}', '\\}'):gsub('\n', '\\N'))
end

local function emit(event)
  mp.commandv('script-message', 'playdeck-event', utils.format_json(event))
end

-- Drawing ------------------------------------------------------------------------------------------

local out

local function push(line)
  out[#out + 1] = line
end

local function style(size, color, opts)
  opts = opts or {}
  return string.format('\\fn%s\\fs%.1f\\b%d\\bord%s\\3c&H%s&\\3a&H60&\\shad0\\q2\\1c&H%s&\\1a&H%s&',
    FONT, size * FONT_SCALE, opts.bold and 1 or 0, opts.border or 0, BLACK, color, opts.alpha or '00')
end

local function text(x, y, align, size, color, body, opts)
  local clip = opts and opts.clip
  push(string.format('{\\an%d\\pos(%.1f,%.1f)%s%s}%s', align, x, y, style(size, color, opts),
    clip and string.format('\\clip(%.1f,%.1f,%.1f,%.1f)', clip[1], clip[2], clip[3], clip[4]) or '', esc(body)))
end

local function shape(path, color, alpha, extra)
  push(string.format('{\\an7\\pos(0,0)\\bord0\\shad0%s\\1c&H%s&\\1a&H%s&\\p1}%s{\\p0}', extra or '', color, alpha or '00', path))
end

local function rounded(x0, y0, x1, y1, r)
  r = math.min(r or 0, (x1 - x0) / 2, (y1 - y0) / 2)
  local k = r * 0.4477
  return string.format(
    'm %.1f %.1f l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f '
      .. 'l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f',
    x0 + r, y0, x1 - r, y0, x1 - k, y0, x1, y0 + k, x1, y0 + r,
    x1, y1 - r, x1, y1 - k, x1 - k, y1, x1 - r, y1,
    x0 + r, y1, x0 + k, y1, x0, y1 - k, x0, y1 - r,
    x0, y0 + r, x0, y0 + k, x0 + k, y0, x0 + r, y0)
end

local function box(x0, y0, x1, y1, color, alpha, r)
  shape(rounded(x0, y0, x1, y1, r), color, alpha)
end

local widths = {}

local function estimate(body, size)
  local width = 0
  for char in tostring(body):gmatch('[%z\1-\127\194-\244][\128-\191]*') do
    width = width + (#char == 1 and 0.56 or 1) * size
  end
  return width
end

-- Exact text widths come from libass itself, through a hidden overlay.
local function width(body, size, bold)
  local key = size .. (bold and 'b' or 'r') .. body
  if widths[key] then return widths[key] end
  measurer.res_x, measurer.res_y = res_x, res_y
  measurer.data = string.format('{\\an7\\pos(0,0)%s}%s', style(size, TEXT, { bold = bold }), esc(body))
  local bounds = measurer:update()
  local w = bounds and bounds.x1 and bounds.x1 > bounds.x0 and (bounds.x1 - bounds.x0) or estimate(body, size)
  widths[key] = w
  return w
end

-- Controller glyphs, drawn like the UI's (src/ui/components/Hints.tsx). Returns the glyph's width.
local function glyph(kind, x, cy)
  if kind == 'dpad' then
    local cx = x + 12
    shape(string.format('m %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f '
      .. 'l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f',
      cx - 4, cy - 12, cx + 4, cy - 12, cx + 4, cy - 4, cx + 12, cy - 4, cx + 12, cy + 4, cx + 4, cy + 4,
      cx + 4, cy + 12, cx - 4, cy + 12, cx - 4, cy + 4, cx - 12, cy + 4, cx - 12, cy - 4, cx - 4, cy - 4),
      GLYPH, GLYPH_ALPHA)
    return 24
  elseif kind == 'down' then
    local cx = x + 12
    shape(string.format('m %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f '
      .. 'l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f',
      cx - 4, cy - 12, cx + 4, cy - 12, cx + 4, cy - 4, cx + 12, cy - 4, cx + 12, cy + 4, cx + 4, cy + 4,
      cx + 4, cy + 12, cx - 4, cy + 12, cx - 4, cy + 4, cx - 12, cy + 4, cx - 12, cy - 4, cx - 4, cy - 4),
      GLYPH, '90')
    shape(rounded(cx - 4, cy + 2, cx + 4, cy + 12, 1.5), GLYPH, '00')
    return 24
  elseif kind == 'menu' then
    box(x, cy - 11, x + 34, cy + 11, GLYPH, GLYPH_ALPHA, 6)
    for i = -1, 1 do
      shape(rounded(x + 10, cy + i * 5 - 1, x + 24, cy + i * 5 + 1, 1), GLYPH_TEXT)
    end
    return 34
  elseif kind == 'lb-rb' then
    box(x, cy - 11, x + 34, cy + 11, GLYPH, GLYPH_ALPHA, 6)
    text(x + 17, cy, 5, 12, GLYPH_TEXT, 'LB', { bold = true })
    box(x + 38, cy - 11, x + 72, cy + 11, GLYPH, GLYPH_ALPHA, 6)
    text(x + 55, cy, 5, 12, GLYPH_TEXT, 'RB', { bold = true })
    return 72
  end
  box(x, cy - 13, x + 26, cy + 13, GLYPH, GLYPH_ALPHA, 13)
  text(x + 13, cy, 5, 14, GLYPH_TEXT, kind:upper(), { bold = true })
  return 26
end

local function glyph_width(kind)
  return (kind == 'dpad' or kind == 'down') and 24 or kind == 'menu' and 34 or kind == 'lb-rb' and 72 or 26
end

-- A row of hints laid out leftwards from x; returns the left edge.
local function hint_row(hints, x, cy, size, color)
  for i = #hints, 1, -1 do
    local kind, label = hints[i][1], hints[i][2]
    local w = width(label, size)
    text(x, cy, 6, size, color or TEXT, label)
    x = x - w - 8 - glyph_width(kind)
    glyph(kind, x, cy)
    x = x - 28
  end
  return x
end

local function hints_bar(hints)
  local y0 = res_y - HINTS_HEIGHT
  shape(rounded(0, y0, res_x, res_y, 0), BAR_BG, '0F')
  shape(rounded(0, y0, res_x, y0 + 1, 0), 'FFFFFF', 'F0')
  hint_row(hints, res_x - 32, y0 + HINTS_HEIGHT / 2, 16)
end

-- Playback state -----------------------------------------------------------------------------------

local function marker_at(t)
  if not session or not t then return nil end
  for i, marker in ipairs(session.markers or {}) do
    if t >= marker.start and t < marker['end'] - 0.5 then return i, marker end
  end
end

local function next_trigger()
  if final_credits then return final_credits.start end
  if props.duration and props.duration > NEXT_LEAD * 3 then return props.duration - NEXT_LEAD end
end

local function position()
  return state.scrub or props.pos or 0
end

local draw

local function arm_hide()
  if hide_timer then hide_timer:kill() end
  hide_timer = mp.add_timeout(HIDE_AFTER, function()
    if props.paused or state.scrub then return arm_hide() end
    state.osd = false
    draw()
  end)
end

local function show_osd()
  state.osd = true
  arm_hide()
  draw()
end

local function toast(body)
  state.toast = body
  if toast_timer then toast_timer:kill() end
  toast_timer = mp.add_timeout(TOAST_TIME, function()
    state.toast = nil
    draw()
  end)
  draw()
end

local quitting = false
local sync_scope_shader

local function clear_scope_shader()
  local list = mp.get_property_native('glsl-shaders')
  if type(list) == 'table' then
    local kept = {}
    for _, path in ipairs(list) do
      if type(path) ~= 'string' or not path:find('playdeck-scope-', 1, true) then kept[#kept + 1] = path end
    end
    if #kept ~= #list then mp.set_property_native('glsl-shaders', kept) end
  end
  if scope_shader_path then
    os.remove(scope_shader_path)
    scope_shader_path = nil
  end
  last_shader_sig = ''
end

local function quit()
  if quitting then return end
  quitting = true
  if stop_timer then stop_timer:kill() end
  state.osd, state.stats, state.menu, state.stop_armed, state.stop_releasing, state.next_card, state.toast = false, false, nil, false, false, nil, nil
  clear_scope_shader()
  mp.set_property_bool('pause', true)
  show_curtain()
  draw()
  emit({ type = 'stop' })
  -- Fallback when running outside the Electron host (e.g. local test rig).
  mp.add_timeout(0.5, function() mp.commandv('quit') end)
end

local function arm_stop()
  state.stop_armed = true
  if stop_timer then stop_timer:kill() end
  stop_timer = mp.add_timeout(STOP_WINDOW, function()
    state.stop_armed = false
    draw()
  end)
end

local function has_stat(name)
  return stats_sections ~= nil and stats_sections[name] == true
end

-- Stats stay up beside the playback menu. The track menu covers the screen, so the HUD yields.
local function cards_visible()
  return state.stats and not curtain and not loading_next and not (state.menu and state.menu.kind == 'tracks')
end

local function emit_stats_sections()
  local list = {}
  for _, name in ipairs(STATS_ORDER) do
    if stats_sections and stats_sections[name] then list[#list + 1] = name end
  end
  emit({ type = 'statsSections', sections = list })
end

local function toggle_stat(name)
  if not stats_sections then return end
  stats_sections[name] = not stats_sections[name]
  if stats_sections[name] then state.stats = true end
  emit_stats_sections()
  if sync_scope_shader then sync_scope_shader() end
end

local function waveform_mode()
  return session and session.statsWaveform == 'luma' and 'luma' or 'rgb'
end

local function toggle_waveform()
  if not session then return end
  session.statsWaveform = waveform_mode() == 'luma' and 'rgb' or 'luma'
  emit({ type = 'statsWaveform', mode = session.statsWaveform })
  if sync_scope_shader then sync_scope_shader() end
end

local function sample_network()
  local cache = mp.get_property_native('demuxer-cache-state')
  if not session or not cache then return end
  net.ahead, net.bytes = cache['cache-duration'] or 0, cache['fw-bytes'] or 0
  -- Near its limit the cache only tops up what playback used, at the video's rate, not the network's.
  local limit = mp.get_property_number('demuxer-max-bytes') or math.huge
  net.idle, net.eof = cache.idle == true or net.bytes >= limit * 0.9, cache.eof == true
  net.rate = not (net.idle or net.eof) and (mp.get_property_number('cache-speed') or 0) * 8 or nil
  net.samples[#net.samples + 1] = net.rate or false
  if #net.samples > SAMPLES then table.remove(net.samples, 1) end
  if net.rate then net.sum, net.count, net.last = net.sum + net.rate, net.count + 1, net.rate end
end

local function play_next()
  if loading_next or not session or not session.next then return end
  loading_next = true
  state.next_card, state.menu, state.osd = nil, nil, false
  mp.set_property_bool('pause', true)
  emit({ type = 'next' })
  if next_timer then next_timer:kill() end
  next_timer = mp.add_timeout(NEXT_TIMEOUT, quit)
  draw()
end

local function cancel_next()
  state.next_card, state.next_cancelled = nil, true
  if props.eof then return quit() end
  draw()
end

local function show_next_card()
  if state.next_card or state.next_cancelled or loading_next then return end
  state.next_card = { remaining = session.autoplayNext and NEXT_COUNTDOWN or nil }
end

local function skip_marker(marker)
  mp.commandv('seek', string.format('%.3f', marker['end']), 'absolute')
  state.prompt = nil
end

-- Runs on every frame's position, so it only draws when the prompt or the card changes.
local function update_markers()
  if not session or loading_next then return end
  local t = props.pos
  if not t then return end
  local card, prompt = state.next_card, state.prompt
  if session.next then
    local trigger = next_trigger()
    if trigger and t >= trigger then
      show_next_card()
    elseif state.next_card or state.next_cancelled then
      state.next_card, state.next_cancelled = nil, false
    end
  end
  local i, marker = marker_at(t)
  if marker and marker == final_credits and session.next then i, marker = nil, nil end
  if marker and session.autoSkipMarkers and not state.skipped[i] then
    state.skipped[i] = true
    skip_marker(marker)
    toast(S(marker.kind == 'intro' and 'osd.introSkipped' or 'osd.creditsSkipped'))
    return
  end
  state.prompt = marker and not state.dismissed[i] and i or nil
  if state.next_card ~= card or state.prompt ~= prompt then draw() end
end

-- Tracks -------------------------------------------------------------------------------------------

local function session_tracks(kind)
  local list = {}
  for _, track in ipairs(session and session.tracks or {}) do
    if track.kind == kind then list[#list + 1] = track end
  end
  return list
end

-- Plex stream indexes are FFmpeg's, which mpv reports as ff-index; failing that, the order matches.
-- For unprobed sources (such as WebDAV), embedded tracks are discovered directly from mpv's track-list.
local function lang_score(track, pref)
  if not pref or pref == '' or pref == 'off' then return 0 end
  local tag = (track.lang or ''):lower()
  local text = ((track.title or '') .. ' ' .. tag):lower()
  local is_zh = tag == 'zh' or tag == 'zho' or tag == 'chi' or tag:find('^zh%-')
    or text:find('chinese') or text:find('中文') or text:find('国语') or text:find('粤语') or text:find('简') or text:find('繁')
  local is_hans = tag == 'zh-hans' or tag == 'zh-cn' or tag == 'zh-sg'
    or text:find('simplified') or text:find('chs') or text:find('hans') or text:find('简')
  local is_hant = tag == 'zh-hant' or tag == 'zh-tw' or tag == 'zh-hk'
    or text:find('traditional') or text:find('cht') or text:find('hant') or text:find('繁')

  local base = 0
  if pref == 'ja' and (tag == 'ja' or tag == 'jpn' or tag:find('^ja%-') or text:find('japanese') or text:find('日本') or text:find('日语')) then
    base = 20
  elseif pref == 'en' and (tag == 'en' or tag == 'eng' or tag:find('^en%-') or text:find('english')) then
    base = 20
  elseif pref == 'ko' and (tag == 'ko' or tag == 'kor' or tag:find('^ko%-') or text:find('korean') or text:find('한국') or text:find('韩语')) then
    base = 20
  elseif pref == 'zh' and is_zh then
    base = 20
  elseif pref == 'zh-Hans' then
    if is_hans then base = 20 elseif is_zh and not is_hant then base = 10 end
  elseif pref == 'zh-Hant' then
    if is_hant then base = 20 elseif is_zh and not is_hans then base = 10 end
  end
  if base == 0 then return 0 end
  return base + (track.default and 1 or 0) - (track['hearing-impaired'] and 2 or 0) - (track.forced and 5 or 0)
end

local function compose_track_title(track, fallback_index)
  local parts = {}
  if track.title and track.title ~= '' then parts[#parts + 1] = track.title end
  if track.lang and track.lang ~= '' and (not track.title or not track.title:lower():find(track.lang:lower(), 1, true)) then
    parts[#parts + 1] = track.lang
  end
  if track.codec and track.codec ~= '' then parts[#parts + 1] = track.codec:upper() end
  if #parts == 0 then return 'Track ' .. tostring(fallback_index) end
  return table.concat(parts, ' · ')
end

local function discover_embedded_tracks(mpv_tracks)
  if not session then return end
  session.tracks = session.tracks or {}
  for _, existing in ipairs(session.tracks) do
    if not existing.url then return end
  end

  local next_id = 10000
  local discovered_audio, discovered_sub = {}, {}
  for _, track in ipairs(mpv_tracks) do
    if not track.external and (track.type == 'audio' or track.type == 'sub') then
      next_id = next_id + 1
      local kind = track.type == 'audio' and 'audio' or 'subtitle'
      local entry = {
        id = next_id,
        kind = kind,
        title = compose_track_title(track, track.id),
        language = track.lang,
        ffIndex = track['ff-index'],
        selected = false,
        _raw = track,
      }
      mapped[entry.id] = track.id
      if kind == 'audio' then
        discovered_audio[#discovered_audio + 1] = entry
      else
        discovered_sub[#discovered_sub + 1] = entry
      end
    end
  end

  -- Pick best audio track by preferred language, default flag, or first track.
  if #discovered_audio > 0 then
    local best, best_score = nil, 0
    for _, entry in ipairs(discovered_audio) do
      local score = lang_score(entry._raw, session.audioLanguage)
      if score > best_score then best, best_score = entry, score end
    end
    if not best then
      for _, entry in ipairs(discovered_audio) do
        if entry._raw.default then best = entry; break end
      end
    end
    best = best or discovered_audio[1]
    best.selected = true
  end

  -- Pick best embedded subtitle track only if no sidecar subtitle was already selected.
  local has_selected_sub = false
  for _, existing in ipairs(session.tracks) do
    if existing.kind == 'subtitle' and existing.selected then has_selected_sub = true end
  end
  if not has_selected_sub and #discovered_sub > 0 and session.subtitleLanguage and session.subtitleLanguage ~= 'off' then
    local best, best_score = nil, 0
    for _, entry in ipairs(discovered_sub) do
      local score = lang_score(entry._raw, session.subtitleLanguage)
      if score > best_score then best, best_score = entry, score end
    end
    if best then best.selected = true end
  end

  local combined = {}
  for _, entry in ipairs(discovered_audio) do entry._raw = nil; combined[#combined + 1] = entry end
  for _, entry in ipairs(discovered_sub) do entry._raw = nil; combined[#combined + 1] = entry end
  for _, existing in ipairs(session.tracks) do combined[#combined + 1] = existing end
  session.tracks = combined
end

local function map_tracks()
  mapped = {}
  local mpv_tracks = mp.get_property_native('track-list') or {}
  discover_embedded_tracks(mpv_tracks)
  for kind, mpv_kind in pairs({ audio = 'audio', subtitle = 'sub' }) do
    local embedded = {}
    for _, track in ipairs(mpv_tracks) do
      if track.type == mpv_kind and not track.external then embedded[#embedded + 1] = track end
    end
    local order = 0
    for _, track in ipairs(session_tracks(kind)) do
      if not track.url then
        order = order + 1
        for _, candidate in ipairs(embedded) do
          if candidate['ff-index'] == track.ffIndex then mapped[track.id] = candidate.id end
        end
        if not mapped[track.id] and embedded[order] then mapped[track.id] = embedded[order].id end
      end
    end
  end
end

local function selected_id(kind)
  local current = mp.get_property_native(kind == 'audio' and 'aid' or 'sid')
  for _, track in ipairs(session_tracks(kind)) do
    if mapped[track.id] and mapped[track.id] == current then return track.id end
  end
end

local function sidecar_id(url)
  for _, track in ipairs(mp.get_property_native('track-list') or {}) do
    if track.type == 'sub' and track['external-filename'] == url then return track.id end
  end
end

local function select_track(track, persist)
  if track == nil then
    mp.set_property('sid', 'no')
    if persist then emit({ type = 'tracks', subtitle = 0 }) end
    return
  end
  local property = track.kind == 'audio' and 'aid' or 'sid'
  if mapped[track.id] then
    mp.set_property_number(property, mapped[track.id])
    if persist then emit({ type = 'tracks', [track.kind] = track.id }) end
    return
  end
  if not track.url then return end
  local file = session
  local previous = mp.get_property_native('sid')
  mp.set_property('sid', 'no')
  mp.command_native_async({ name = 'sub-add', url = track.url, flags = 'select', title = track.title, lang = track.language },
    function(success)
      if file ~= session then return end
      local id = success and sidecar_id(track.url)
      if not id then
        mp.set_property_native('sid', previous)
        return toast(S('osd.subtitleFailed'))
      end
      mapped[track.id] = id
      mp.set_property_number('sid', id)
      if persist then emit({ type = 'tracks', subtitle = track.id }) end
      draw()
    end)
end

local function apply_selection()
  map_tracks()
  local subtitle
  for _, track in ipairs(session.tracks or {}) do
    if track.selected then
      if track.kind == 'audio' then select_track(track, false) else subtitle = track end
    end
  end
  select_track(subtitle, false)
end

-- Menus --------------------------------------------------------------------------------------------

local function adjust(property, delta, min, max)
  local value = (mp.get_property_number(property) or 0) + delta
  value = math.floor(value * 1000 + 0.5) / 1000
  mp.set_property_number(property, math.max(min, math.min(max, value)))
end

local function step_speed(direction)
  local speed = mp.get_property_number('speed') or 1
  local index = 3
  for i, value in ipairs(SPEEDS) do
    if math.abs(value - speed) < 0.01 then index = i end
  end
  mp.set_property_number('speed', SPEEDS[math.max(1, math.min(#SPEEDS, index + direction))])
end

local function ms(seconds)
  local value = math.floor(seconds * 1000 + 0.5)
  return (value > 0 and '+' or '') .. value .. ' ms'
end

local function emit_sub_scale()
  emit({ type = 'subtitleScale', scale = math.floor((mp.get_property_number('sub-scale') or 1) * 100 + 0.5) })
end

local function stat_toggle(name, label)
  return {
    label = label,
    toggle = true,
    step = function() toggle_stat(name) end,
    reset = function() toggle_stat(name) end,
    value = function() return S(has_stat(name) and 'osd.on' or 'osd.off') end,
  }
end

local PLAYBACK_ROWS = {
  { label = 'osd.speed', step = step_speed, reset = function() mp.set_property_number('speed', 1) end,
    value = function() return string.format('%g×', mp.get_property_number('speed') or 1) end },
  { label = 'osd.audioDelay', step = function(d) adjust('audio-delay', d * 0.05, -5, 5) end,
    reset = function() mp.set_property_number('audio-delay', 0) end,
    value = function() return ms(mp.get_property_number('audio-delay') or 0) end },
  { label = 'osd.subtitleDelay', step = function(d) adjust('sub-delay', d * 0.1, -30, 30) end,
    reset = function() mp.set_property_number('sub-delay', 0) end,
    value = function() return ms(mp.get_property_number('sub-delay') or 0) end },
  { label = 'osd.subtitleSize', step = function(d) adjust('sub-scale', d * 0.1, 0.5, 2.5); emit_sub_scale() end,
    reset = function() mp.set_property_number('sub-scale', 1); emit_sub_scale() end,
    value = function() return string.format('%d%%', math.floor((mp.get_property_number('sub-scale') or 1) * 100 + 0.5)) end },
  stat_toggle('video', 'osd.statsVideo'),
  stat_toggle('timing', 'osd.statsTiming'),
  stat_toggle('audio', 'osd.statsAudio'),
  stat_toggle('network', 'osd.statsNetwork'),
  stat_toggle('scope', 'osd.statsScope'),
  { label = 'osd.statsWaveform', toggle = true, step = function() toggle_waveform() end, reset = function() toggle_waveform() end,
    value = function() return S(waveform_mode() == 'luma' and 'osd.waveformLuma' or 'osd.waveformRgb') end },
}

local function open_tracks()
  local columns = { { kind = 'audio', rows = session_tracks('audio') }, { kind = 'subtitle', rows = session_tracks('subtitle') } }
  table.insert(columns[2].rows, 1, false) -- "Off"
  for _, column in ipairs(columns) do
    column.cursor, column.scroll = 1, 0
    local current = selected_id(column.kind)
    for i, row in ipairs(column.rows) do
      if (row and row.id == current) or (not row and not current) then column.cursor = i end
    end
  end
  -- With a single audio track, the choice to make is the subtitles.
  state.menu = { kind = 'tracks', columns = columns, column = #columns[1].rows > 1 and 1 or 2 }
  state.osd, state.stop_armed = false, false
end

local function open_playback()
  state.menu = { kind = 'playback', cursor = 1 }
  state.osd, state.stop_armed = false, false
end

local function close_menu()
  state.menu = nil
  if props.paused then show_osd() end
end

local function menu_move(dx, dy)
  local menu = state.menu
  if menu.kind == 'tracks' then
    if dx ~= 0 then
      local column = menu.column + dx
      if column >= 1 and column <= 2 and #menu.columns[column].rows > 0 then menu.column = column end
    else
      local column = menu.columns[menu.column]
      column.cursor = math.max(1, math.min(#column.rows, column.cursor + dy))
    end
  elseif menu.kind == 'playback' then
    if dy ~= 0 then
      menu.cursor = math.max(1, math.min(#PLAYBACK_ROWS, menu.cursor + dy))
    else
      PLAYBACK_ROWS[menu.cursor].step(dx)
    end
  end
end

local function menu_confirm()
  local menu = state.menu
  if menu.kind == 'tracks' then
    local column = menu.columns[menu.column]
    local row = column.rows[column.cursor]
    if row == nil then return end
    select_track(row or nil, true)
  elseif menu.kind == 'playback' then
    PLAYBACK_ROWS[menu.cursor].reset()
  end
end

-- Rendering ----------------------------------------------------------------------------------------

local function draw_bar(y)
  local x0, x1 = MARGIN, res_x - MARGIN
  local duration = props.duration or 0
  local span = x1 - x0
  local function at(t)
    return x0 + span * math.max(0, math.min(1, duration > 0 and t / duration or 0))
  end
  box(x0, y, x1, y + 6, 'FFFFFF', 'C8', 3)
  local cache = mp.get_property_native('demuxer-cache-state')
  for _, range in ipairs(cache and cache['seekable-ranges'] or {}) do
    box(at(range.start), y, at(range['end']), y + 6, 'FFFFFF', 'A0', 3)
  end
  for _, marker in ipairs(session.markers or {}) do
    box(at(marker.start), y, at(marker['end']), y + 6, MUTED, '60', 0)
  end
  box(x0, y, at(props.pos or 0), y + 6, ACCENT, '00', 3)
  for _, chapter in ipairs(mp.get_property_native('chapter-list') or {}) do
    if chapter.time > 1 and chapter.time < duration - 1 then
      local cx = at(chapter.time)
      shape(rounded(cx - 1, y - 3, cx + 1, y + 9, 0), TEXT, '30')
    end
  end
  local head = at(position())
  box(head - 8, y + 3 - 8, head + 8, y + 3 + 8, TEXT, '00', 8)
  if state.scrub then
    local label = clock(state.scrub)
    local w = width(label, 18, true) + 20
    local left = math.max(x0, math.min(x1 - w, head - w / 2))
    box(left, y - 44, left + w, y - 14, SURFACE, '10', 8)
    text(left + w / 2, y - 29, 5, 18, TEXT, label, { bold = true })
  end
end

local function draw_osd()
  local y_bar = res_y - HINTS_HEIGHT - 44
  if props.paused then
    box(MARGIN, y_bar - 130, MARGIN + 6, y_bar - 104, TEXT, '00', 2)
    box(MARGIN + 14, y_bar - 130, MARGIN + 20, y_bar - 104, TEXT, '00', 2)
  end
  text(MARGIN, y_bar - 56, 1, 30, TEXT, session.title or '', { bold = true, clip = { MARGIN, 0, res_x - 420, res_y } })
  if session.subtitle and session.subtitle ~= '' then
    text(MARGIN, y_bar - 24, 1, 18, MUTED, session.subtitle)
  end
  draw_bar(y_bar)
  local duration = props.duration or 0
  local y_time = y_bar + 24
  text(MARGIN, y_time, 4, 18, TEXT, clock(position()))
  local remaining = math.max(0, duration - position())
  local speed = mp.get_property_number('speed') or 1
  local ends = os.date('%H:%M', os.time() + math.floor(remaining / speed))
  text(res_x - MARGIN, y_time, 6, 18, MUTED, '−' .. clock(remaining) .. '  ·  ' .. S('osd.endsAt', { time = ends }))
  local read_bps = (mp.get_property_number('cache-speed') or 0) * 8
  text(res_x - MARGIN, 36, 9, 20, TEXT, rate_text(read_bps) .. '  ·  ' .. os.date('%H:%M'), { border = 1.5 })
  hints_bar({
    { 'dpad', S('osd.seek') },
    { 'lb-rb', S('osd.chapter') },
    { 'menu', S('osd.menu') },
    { 'y', S('osd.tracks') },
    { 'x', S('osd.stats') },
    { 'a', S(props.paused and 'osd.play' or 'osd.pause') },
    { 'down', S('osd.hide') },
  })
end

local function prompt_bottom()
  return state.osd and (res_y - HINTS_HEIGHT - 44 - 72) or (res_y - 56)
end

local function draw_prompt()
  local marker = session.markers[state.prompt]
  local label = S(marker.kind == 'intro' and 'osd.skipIntro' or 'osd.skipCredits')
  local w = 26 + 12 + width(label, 18, true) + 40
  local x1, y1 = res_x - MARGIN, prompt_bottom()
  box(x1 - w, y1 - 48, x1, y1, SURFACE, '10', 24)
  glyph('a', x1 - w + 20, y1 - 24)
  text(x1 - 20, y1 - 24, 6, 18, TEXT, label, { bold = true })
end

local function draw_next_card()
  local card = state.next_card
  local w, h = 400, 150
  local x1, y1 = res_x - MARGIN, prompt_bottom()
  local x0, y0 = x1 - w, y1 - h
  box(x0, y0, x1, y1, SURFACE, '08', 14)
  text(x0 + 20, y0 + 20, 7, 14, MUTED, S('osd.next'), { bold = true })
  text(x0 + 20, y0 + 42, 7, 20, TEXT, session.next.title or '', { bold = true, clip = { x0, y0, x1 - 16, y1 } })
  if session.next.subtitle then
    text(x0 + 20, y0 + 70, 7, 16, MUTED, session.next.subtitle, { clip = { x0, y0, x1 - 16, y1 } })
  end
  local cy = y1 - 28
  hint_row({ { 'a', S('osd.playNow') }, { 'down', S('osd.cancel') } }, x1 - 20, cy, 15)
  if card.remaining then
    text(x0 + 20, cy, 4, 15, ACCENT, S('osd.nextIn', { n = math.max(1, math.ceil(card.remaining)) }), { bold = true })
    local fraction = card.remaining / NEXT_COUNTDOWN
    box(x0 + 14, y1 - 4, x0 + 14 + (w - 28) * fraction, y1 - 1, ACCENT, '00', 1)
  end
end

local function draw_center(body)
  local w = width(body, 20, true) + 48
  local cx, cy = res_x / 2, res_y / 2
  box(cx - w / 2, cy - 28, cx + w / 2, cy + 28, SURFACE, '20', 14)
  text(cx, cy, 5, 20, TEXT, body, { bold = true })
end

local function draw_toast()
  local w = width(state.toast, 17) + 48
  local cx = res_x / 2
  box(cx - w / 2, 68, cx + w / 2, 112, SURFACE, '10', 22)
  text(cx, 90, 5, 17, TEXT, state.toast)
end

local function draw_tracks(menu)
  local pw = math.min(res_x - 128, 1040)
  local x0, y0 = (res_x - pw) / 2, 64
  local y1 = res_y - HINTS_HEIGHT - 40
  box(x0, y0, x0 + pw, y1, SURFACE, '08', 16)
  local row_h, top = 46, y0 + 76
  local visible = math.floor((y1 - 20 - top) / row_h)
  local col_w = (pw - 72) / 2
  for c, column in ipairs(menu.columns) do
    local cx0 = x0 + 24 + (c - 1) * (col_w + 24)
    local cx1 = cx0 + col_w
    text(cx0 + 12, y0 + 40, 4, 15, MUTED, S(column.kind == 'audio' and 'osd.audio' or 'osd.subtitles'), { bold = true })
    if column.cursor > column.scroll + visible then column.scroll = column.cursor - visible end
    if column.cursor <= column.scroll then column.scroll = column.cursor - 1 end
    local current = selected_id(column.kind)
    for i = column.scroll + 1, math.min(#column.rows, column.scroll + visible) do
      local row = column.rows[i]
      local ry = top + (i - column.scroll - 1) * row_h
      local focused = menu.column == c and column.cursor == i
      if focused then box(cx0, ry, cx1, ry + row_h - 6, 'FFFFFF', 'E0', 10) end
      local active = (row and row.id == current) or (not row and current == nil)
      if active then box(cx0 + 14, ry + 15, cx0 + 24, ry + 25, ACCENT, '00', 5) end
      text(cx0 + 38, ry + (row_h - 6) / 2, 4, 19, (focused or active) and TEXT or MUTED, row and row.title or S('osd.off'),
        { bold = active, clip = { cx0, ry, cx1 - 10, ry + row_h } })
    end
    if #column.rows == 0 then text(cx0 + 38, top + 20, 4, 19, MUTED, '—') end
  end
  hints_bar({ { 'a', S('osd.select') }, { 'b', S('osd.back') } })
end

local function draw_playback(menu)
  local row_h = 50
  local ph = 84 + #PLAYBACK_ROWS * row_h
  local reserved_left = cards_visible() and (MARGIN + 300 + 16) or 0
  local reserved_right = (cards_visible() and has_stat('scope') and scope_layout) and (res_x - scope_layout().x0 + 12) or 0
  local pw = math.max(360, math.min(640, res_x - reserved_left - reserved_right - 24))
  local x0 = reserved_left + math.max(12, (res_x - reserved_left - reserved_right - pw) / 2)
  local y0 = math.max(16, (res_y - HINTS_HEIGHT - ph) / 2)
  box(x0, y0, x0 + pw, y0 + ph, SURFACE, '08', 16)
  text(x0 + 32, y0 + 40, 4, 22, TEXT, S('osd.playback'), { bold = true })
  for i, row in ipairs(PLAYBACK_ROWS) do
    local ry = y0 + 68 + (i - 1) * row_h
    local focused = menu.cursor == i
    if focused then box(x0 + 16, ry, x0 + pw - 16, ry + row_h - 6, 'FFFFFF', 'E0', 10) end
    local cy = ry + (row_h - 6) / 2
    text(x0 + 32, cy, 4, 19, focused and TEXT or MUTED, S(row.label), { clip = { x0 + 28, ry, x0 + pw - 132, ry + row_h } })
    local value = row.value()
    text(x0 + pw - 32, cy, 6, 19, TEXT, (focused and '‹  ' or '') .. value .. (focused and '  ›' or ''), { bold = true })
  end
  local confirm = PLAYBACK_ROWS[menu.cursor].toggle and 'osd.toggle' or 'osd.reset'
  hints_bar({ { 'dpad', S('osd.adjust') }, { 'a', S(confirm) }, { 'b', S('osd.back') } })
end

local function draw_stop_hint()
  local label = S('osd.stopAgain')
  local w = 18 + 26 + 12 + width(label, 17) + 24
  local x0 = (res_x - w) / 2
  box(x0, 68, x0 + w, 112, SURFACE, '10', 22)
  glyph('b', x0 + 18, 90)
  text(x0 + 18 + 26 + 12, 90, 4, 17, TEXT, label)
end

-- One bar per second of the last minute, the newest on the right; bars below the video's bit rate are red.
local function draw_graph(x0, y0, x1, y1, bitrate)
  box(x0, y0, x1, y1, 'FFFFFF', 'F0', 4)
  local peak = bitrate or 0
  for _, rate in ipairs(net.samples) do
    if rate and rate > peak then peak = rate end
  end
  if peak <= 0 then return end
  peak = peak * 1.15
  local slot = (x1 - x0) / SAMPLES
  local first = SAMPLES - #net.samples
  local fast, slow = {}, {}
  for i, rate in ipairs(net.samples) do
    if rate and rate > 0 then
      local bx = x0 + (first + i - 1) * slot
      local top = y1 - (y1 - y0) * rate / peak
      local list = (bitrate and rate < bitrate) and slow or fast
      list[#list + 1] = string.format('m %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f',
        bx, y1, bx, top, bx + slot - 1, top, bx + slot - 1, y1)
    end
  end
  if #fast > 0 then shape(table.concat(fast, ' '), ACCENT, '20') end
  if #slow > 0 then shape(table.concat(slow, ' '), WARN, '20') end
  if bitrate then
    local by = y1 - (y1 - y0) * bitrate / peak
    shape(rounded(x0, by - 0.75, x1, by + 0.75, 0), TEXT, '50')
  end
end

-- Stats HUD ---------------------------------------------------------------------------------------

local STATS_W = 300
local SCOPE_HEADER = 32
local WAVE_H = 156
local SCOPE_GUTTER = 42
local SCOPE_PAD = 12
local SCOPE_GAP = 10
local TRC_NAME = {
  pq = 'PQ', smpte2084 = 'PQ', hlg = 'HLG', ['arib-std-b67'] = 'HLG',
  ['bt.1886'] = 'BT.1886', bt1886 = 'BT.1886', srgb = 'sRGB', gamma22 = 'Gamma 2.2', gamma28 = 'Gamma 2.8',
}
local PRIM_NAME = { ['bt.709'] = 'BT.709', ['bt.2020'] = 'BT.2020', ['display-p3'] = 'P3', ['dci-p3'] = 'DCI-P3' }
local HW_NAME = { vaapi = 'VA-API', ['vaapi-copy'] = 'VA-API', nvdec = 'NVDEC', vulkan = 'Vulkan', videotoolbox = 'VT' }
local CODEC_NAME = { hevc = 'HEVC', h264 = 'H.264', av1 = 'AV1', vp9 = 'VP9', avc = 'H.264' }
local scope_template

local function prop(name)
  local value = mp.get_property(name)
  if value == nil or value == '' then return nil end
  return value
end

local function join_dot(parts)
  local list = {}
  for _, part in ipairs(parts) do
    if part and part ~= '' then list[#list + 1] = part end
  end
  return #list > 0 and table.concat(list, ' · ') or '—'
end

local function selected_video()
  for _, track in ipairs(mp.get_property_native('track-list') or {}) do
    if track.type == 'video' and track.selected then return track end
  end
end

local function depth_of(pix)
  if not pix then return nil end
  local lowered = pix:lower()
  local n = tonumber(lowered:match('p0?(%d%d)') or lowered:match('(%d%d)le') or lowered:match('(%d%d)be'))
  if n and n >= 8 and n <= 16 then return n .. '-bit' end
  if lowered == 'yuv420p' or lowered == 'nv12' or lowered:find('rgb24', 1, true) then return '8-bit' end
end

local function dr_badge()
  local profile = tonumber(selected_video() and selected_video()['dolby-vision-profile'])
  if profile and profile > 0 then return 'DV ' .. profile, PURPLE end
  local gamma = prop('video-params/gamma') or ''
  if gamma == 'pq' or gamma == 'smpte2084' then return 'HDR10', ACCENT end
  if gamma == 'hlg' or gamma == 'arib-std-b67' then return 'HLG', ACCENT end
  return 'SDR', MUTED
end

local function hw_badge()
  local hw = prop('hwdec-current') or 'no'
  if hw == 'no' then return 'SW', ACCENT end
  return HW_NAME[hw] or hw:upper(), GREEN
end

local function signal_text(prefix)
  local gamma = prop(prefix .. '/gamma')
  local prim = prop(prefix .. '/primaries')
  return join_dot({ gamma and (TRC_NAME[gamma] or gamma), prim and (PRIM_NAME[prim] or prim) })
end

local function scope_mode()
  local gamma = prop('video-out-params/gamma') or prop('video-params/gamma') or ''
  local prim = prop('video-out-params/primaries') or prop('video-params/primaries') or ''
  local pq = (gamma == 'pq' or gamma == 'smpte2084') and 1 or 0
  local prim_id = prim == 'bt.2020' and 1 or (prim == 'display-p3' or prim == 'dci-p3') and 2 or 0
  local peak = math.max(50, math.min(1000, tonumber(session and session.hdrSubtitleBrightness) or 203))
  return pq, prim_id, peak
end

local function pq_code(nits)
  local m1, m2 = 0.1593017578125, 78.84375
  local c1, c2, c3 = 0.8359375, 18.8515625, 18.6875
  local p = (math.max(nits, 0) / 10000) ^ m1
  return ((c1 + c2 * p) / (1 + c3 * p)) ^ m2
end

-- The OUTPUT hook only covers the fitted picture. Margins are the black bars around it, in window pixels.
local function video_box()
  local dims = mp.get_property_native('osd-dimensions') or {}
  local ow, oh = dims.w or 0, dims.h or 0
  if ow < 2 or oh < 2 then
    return { x = 0, y = 0, w = res_x, h = res_y, ml = 0, mt = 0, sx = 1, sy = 1 }
  end
  local ml, mr = dims.ml or 0, dims.mr or 0
  local mt, mb = dims.mt or 0, dims.mb or 0
  local sx, sy = ow / res_x, oh / res_y
  return {
    x = ml / sx, y = mt / sy,
    w = math.max(1, ow - ml - mr) / sx,
    h = math.max(1, oh - mt - mb) / sy,
    ml = ml, mt = mt, sx = sx, sy = sy,
  }
end

local function left_stats_open()
  return has_stat('video') or has_stat('timing') or has_stat('audio') or has_stat('network')
end

-- Waveform above the gamut. The panel is 60% of its previous width, and it stays inside the
-- picture so the shader and the labels share one rectangle.
scope_layout = function()
  local video = video_box()
  local left = left_stats_open() and (MARGIN + STATS_W + 16) or MARGIN
  local available = math.max(220, res_x - left - MARGIN)
  local w = math.floor(available * 0.6 * 0.6)
  local inset = 12
  w = math.max(200, math.min(w, math.max(200, video.w - inset * 2)))
  local x1 = math.min(res_x - MARGIN, video.x + video.w - inset)
  local x0 = math.max(video.x + inset, x1 - w)
  if x0 > x1 then x0 = x1 end
  w = math.max(1, x1 - x0)
  local y0 = math.max(video.y + inset, state.osd and 72 or (video.y + inset))
  local bottom = video.y + video.h - inset
  if state.osd then bottom = math.min(bottom, res_y - HINTS_HEIGHT - 72) end
  local room = math.max(160, bottom - y0)
  local inner_w = math.max(80, w - SCOPE_GUTTER - SCOPE_PAD)
  local wave_h = math.min(WAVE_H, math.floor(room * 0.36))
  -- The horseshoe is a square under the waveform. Cap it so the per-pixel cloud stays cheap on Deck.
  local gam = math.min(inner_w, 280, room - SCOPE_HEADER - wave_h - SCOPE_GAP - SCOPE_PAD)
  if gam < 96 then
    wave_h = math.max(64, room - SCOPE_HEADER - 96 - SCOPE_GAP - SCOPE_PAD)
    gam = math.max(72, math.min(inner_w, room - SCOPE_HEADER - wave_h - SCOPE_GAP - SCOPE_PAD))
  end
  local h = math.min(room, SCOPE_HEADER + wave_h + SCOPE_GAP + gam + SCOPE_PAD)
  return {
    x0 = x0, y0 = y0, w = w, h = h, video = video,
    wf_x = x0 + SCOPE_GUTTER, wf_y = y0 + SCOPE_HEADER, wf_w = inner_w, wf_h = wave_h,
    gam_x = x0 + SCOPE_GUTTER + (inner_w - gam) / 2,
    gam_y = y0 + SCOPE_HEADER + wave_h + SCOPE_GAP, gam = gam,
  }
end

local function load_scope_template()
  if scope_template then return scope_template end
  local source = debug.getinfo(1, 'S').source
  if source:sub(1, 1) == '@' then source = source:sub(2) end
  local path = (source:match('^(.*)/') or '.') .. '/scope.glsl'
  local handle = io.open(path, 'r')
  if not handle then
    msg.warn('missing scope shader: ' .. path)
    return nil
  end
  scope_template = handle:read('*a')
  handle:close()
  return scope_template
end

local function shader_number(value)
  return string.format('%.2f', value)
end

sync_scope_shader = function()
  if not (cards_visible() and has_stat('scope')) then
    clear_scope_shader()
    return
  end
  local template = load_scope_template()
  local dims = mp.get_property_native('osd-dimensions') or {}
  local ow, oh = dims.w or 0, dims.h or 0
  if not template or ow < 2 or oh < 2 then return end
  local layout = scope_layout()
  local pq, prim, peak = scope_mode()
  local video = layout.video
  local function hookx(v) return v * video.sx - video.ml end
  local function hooky(v) return v * video.sy - video.mt end
  local function hooks(v) return v * video.sx end
  local function hookt(v) return v * video.sy end
  local values = {
    PQ = pq, PRIM = prim, PEAK = string.format('%.1f', peak),
    LUMA = waveform_mode() == 'luma' and 1 or 0,
    RADIUS = shader_number(12 * video.sx),
    CARD_X = shader_number(hookx(layout.x0)), CARD_Y = shader_number(hooky(layout.y0)),
    CARD_W = shader_number(hooks(layout.w)), CARD_H = shader_number(hookt(layout.h)),
    WAVE_X = shader_number(hookx(layout.wf_x)), WAVE_Y = shader_number(hooky(layout.wf_y)),
    WAVE_W = shader_number(hooks(layout.wf_w)), WAVE_H = shader_number(hookt(layout.wf_h)),
    GAMUT_X = shader_number(hookx(layout.gam_x)), GAMUT_Y = shader_number(hooky(layout.gam_y)),
    GAMUT_S = shader_number(math.min(hooks(layout.gam), hookt(layout.gam))),
  }
  local sig = ''
  for _, name in ipairs({
    'PQ', 'PRIM', 'PEAK', 'LUMA', 'RADIUS', 'CARD_X', 'CARD_Y', 'CARD_W', 'CARD_H',
    'WAVE_X', 'WAVE_Y', 'WAVE_W', 'WAVE_H', 'GAMUT_X', 'GAMUT_Y', 'GAMUT_S',
  }) do
    sig = sig .. name .. '=' .. values[name] .. ';'
  end
  if sig == last_shader_sig then return end
  local body = template:gsub('@([%w_]+)@', function(key)
    return values[key] ~= nil and tostring(values[key]) or nil
  end)
  scope_seq = scope_seq + 1
  local path = string.format('%s/playdeck-scope-%d.glsl', run_dir, scope_seq)
  local previous = scope_shader_path
  local handle = io.open(path, 'w')
  if not handle then
    msg.warn('could not write scope shader')
    return
  end
  handle:write(body)
  handle:close()
  scope_shader_path = path
  last_shader_sig = sig
  local kept = {}
  local list = mp.get_property_native('glsl-shaders')
  if type(list) == 'table' then
    for _, item in ipairs(list) do
      if type(item) == 'string' and not item:find('playdeck-scope-', 1, true) then kept[#kept + 1] = item end
    end
  end
  kept[#kept + 1] = path
  mp.set_property_native('glsl-shaders', kept)
  if previous and previous ~= path then os.remove(previous) end
end

local function card_box(x, y, w, h)
  box(x, y, x + w, y + h, SURFACE, '28', 12)
end

local function stat_line(x, y, w, body, color)
  text(x + 14, y, 4, 15, color or TEXT, body, { clip = { x + 12, y - 12, x + w - 12, y + 14 } })
end

local function draw_badges(x_right, y, badges)
  local rx = x_right
  for i = #badges, 1, -1 do
    local label, color = badges[i][1], badges[i][2]
    local bw = width(label, 11, true) + 14
    rx = rx - bw
    box(rx, y - 9, rx + bw, y + 9, color, 'C4', 7)
    text(rx + bw / 2, y, 5, 11, color, label, { bold = true })
    rx = rx - 6
  end
end

local function draw_video_card(x, y, w)
  local codec = prop('video-format') or prop('video-codec') or ''
  codec = CODEC_NAME[codec:lower()] or (codec ~= '' and codec:upper() or nil)
  local vw, vh = mp.get_property_number('video-params/w'), mp.get_property_number('video-params/h')
  local resolution = (vw and vh) and string.format('%d×%d', vw, vh) or nil
  local pix = prop('video-params/hw-pixelformat') or prop('video-params/pixelformat')
  local lines = {
    join_dot({ codec, resolution, depth_of(pix) }),
    signal_text('video-params'),
    '→  ' .. signal_text('video-out-params'),
  }
  local bitrate = mp.get_property_number('video-bitrate')
  if not (bitrate and bitrate > 0) and session.bitrate and session.bitrate > 0 then bitrate = session.bitrate * 1000 end
  if bitrate and bitrate > 0 then lines[#lines + 1] = rate_text(bitrate) end
  local mastering = {}
  local peak = mp.get_property_number('video-params/max-luma')
  local cll = mp.get_property_number('video-params/max-cll')
  local fall = mp.get_property_number('video-params/max-fall')
  local out_peak = mp.get_property_number('video-out-params/max-luma')
  if peak and peak > 0 then mastering[#mastering + 1] = string.format('Peak %.0f nits', peak) end
  if cll and cll > 0 then mastering[#mastering + 1] = string.format('MaxCLL %.0f', cll) end
  if fall and fall > 0 then mastering[#mastering + 1] = string.format('MaxFALL %.0f', fall) end
  if out_peak and out_peak > 0 then mastering[#mastering + 1] = string.format('Out %.0f nits', out_peak) end
  if #mastering > 0 then lines[#lines + 1] = table.concat(mastering, ' · ') end
  local h = 40 + #lines * 22 + 8
  card_box(x, y, w, h)
  text(x + 14, y + 18, 4, 13, ACCENT, S('osd.cardVideo'), { bold = true })
  local dr, dr_color = dr_badge()
  local hw, hw_color = hw_badge()
  draw_badges(x + w - 12, y + 18, { { dr, dr_color }, { hw, hw_color } })
  for i, line in ipairs(lines) do stat_line(x, y + 24 + i * 22, w, line) end
  return h
end

local function pass_last_ms()
  local vo = mp.get_property_native('vo-passes')
  if type(vo) ~= 'table' then return nil end
  local passes = vo.fresh or vo.redraw or vo.render
  if type(passes) ~= 'table' then
    for _, value in pairs(vo) do
      if type(value) == 'table' then passes = value break end
    end
  end
  if type(passes) ~= 'table' then return nil end
  local sum, any = 0, false
  for _, pass in ipairs(passes) do
    if type(pass) == 'table' and type(pass.last) == 'number' then
      any, sum = true, sum + pass.last
    end
  end
  -- mpv reports pass times in nanoseconds (stats.lua shows them in microseconds).
  return any and sum / 1e6 or nil
end

local function draw_timing_card(x, y, w)
  local src = mp.get_property_number('container-fps') or mp.get_property_number('estimated-vf-fps')
  local disp = mp.get_property_number('display-fps') or mp.get_property_number('estimated-display-fps')
  local fps = join_dot({
    src and string.format('%.3f fps', src) or nil,
    disp and string.format('%.2f Hz', disp) or nil,
  })
  if src and disp and src > 0 then
    fps = fps .. string.format('  ·  ×%.2f', disp / src)
  end
  local drops = mp.get_property_number('frame-drop-count') or 0
  local decoded = mp.get_property_number('decoder-frame-drop-count') or 0
  local mistimed = mp.get_property_number('mistimed-frame-count') or 0
  local delayed = mp.get_property_number('vo-delayed-frame-count') or 0
  local drop_color = (drops + decoded) > 0 and WARN or mistimed > 0 and ACCENT or GREEN
  local av = mp.get_property_number('avsync')
  local sync = '—'
  local sync_color = MUTED
  if av then
    sync = string.format('%+.0f ms', av * 1000)
    local jitter = mp.get_property_number('vsync-jitter')
    if jitter then sync = sync .. string.format(' · %.1f ms', math.abs(jitter) * 1000) end
    sync_color = math.abs(av) > 0.04 and WARN or math.abs(av) > 0.02 and ACCENT or GREEN
  end
  local ms = pass_last_ms()
  local budget = 1000 / math.max(disp or 60, 1)
  local frac = ms and math.max(0, math.min(1.5, ms / budget)) or 0
  local bar_color = not ms and MUTED or frac < 0.75 and GREEN or frac < 1 and ACCENT or WARN
  local h = 140
  card_box(x, y, w, h)
  text(x + 14, y + 18, 4, 13, drop_color, S('osd.cardTiming'), { bold = true })
  local sync_name = prop('video-sync')
  if sync_name then
    local short = sync_name:gsub('^display%-', ''):gsub('^resample%-', '')
    draw_badges(x + w - 12, y + 18, { { short, MUTED } })
  end
  stat_line(x, y + 44, w, fps)
  local label = ms and string.format('%.2f / %.1f ms', ms, budget) or '—'
  stat_line(x, y + 66, w, label, bar_color)
  local bar_w = w - 28
  box(x + 14, y + 80, x + 14 + bar_w, y + 86, 'FFFFFF', 'D0', 3)
  local fill = bar_w * math.min(frac, 1)
  if fill >= 1 then box(x + 14, y + 80, x + 14 + fill, y + 86, bar_color, '00', 3) end
  stat_line(x, y + 102, w, sync, sync_color)
  stat_line(x, y + 124, w, string.format('VO %d · Dec %d · mistime %d · late %d', drops, decoded, mistimed, delayed), drop_color)
  return h
end

local function draw_audio_card(x, y, w)
  local codec = prop('audio-codec-name') or prop('audio-codec')
  local layout = prop('audio-params/hr-channels')
  local channels = mp.get_property_number('audio-params/channel-count')
  local rate = mp.get_property_number('audio-params/samplerate')
  local format = prop('audio-params/format')
  local bitrate = mp.get_property_number('audio-bitrate')
  local lines = {
    codec or '—',
    join_dot({ layout or (channels and channels .. ' ch' or nil), rate and string.format('%.1f kHz', rate / 1000) or nil, format }),
    (bitrate and bitrate > 0) and rate_text(bitrate) or '—',
  }
  local h = 40 + #lines * 22 + 8
  card_box(x, y, w, h)
  text(x + 14, y + 18, 4, 13, TEAL, S('osd.cardAudio'), { bold = true })
  local ao = prop('current-ao')
  if ao then draw_badges(x + w - 12, y + 18, { { ao, TEAL } }) end
  for i, line in ipairs(lines) do stat_line(x, y + 24 + i * 22, w, line) end
  return h
end

local function draw_network_card(x, y, w)
  local h = 158
  card_box(x, y, w, h)
  local status = net.eof and 'osd.cachedAll' or net.idle and 'osd.cacheFull' or 'osd.reading'
  text(x + 14, y + 18, 4, 13, PURPLE, S('osd.cardNetwork'), { bold = true })
  draw_badges(x + w - 12, y + 18, { { S(status), MUTED } })
  local bitrate = session.bitrate and session.bitrate * 1000
  local shown = net.rate or net.last
  local color = not net.rate and MUTED or (bitrate and net.rate < bitrate) and WARN or TEXT
  text(x + 14, y + 48, 4, 22, color, shown and rate_text(shown) or '—', { bold = true })
  draw_graph(x + 14, y + 64, x + w - 14, y + 100, bitrate)
  local meta = {}
  if bitrate then meta[#meta + 1] = S('osd.bitrate', { rate = rate_text(bitrate) }) end
  if net.count > 0 then meta[#meta + 1] = S('osd.average', { rate = rate_text(net.sum / net.count) }) end
  stat_line(x, y + 116, w, #meta > 0 and table.concat(meta, ' · ') or '—', MUTED)
  stat_line(x, y + 136, w, S('osd.ahead', { time = clock(net.ahead), size = size_text(net.bytes) }))
  return h
end

local function draw_scope_card()
  local layout = scope_layout()
  local pq = scope_mode()
  local title = S('osd.cardScope')
  local badge = (waveform_mode() == 'luma' and S('osd.waveformLuma') or S('osd.waveformRgb')) .. '  ·  ' .. (pq == 1 and 'PQ · nits' or 'SDR · %')
  local badge_w = width(badge, 11, true)
  local badge_left = layout.x0 + layout.w - 14 - badge_w
  text(layout.x0 + 14, layout.y0 + 18, 4, 13, TEXT, title, {
    bold = true, border = 1.2,
    clip = { layout.x0 + 8, layout.y0, badge_left - 8, layout.y0 + SCOPE_HEADER },
  })
  text(badge_left + badge_w, layout.y0 + 18, 6, 11, pq == 1 and ACCENT or MUTED, badge, { bold = true, border = 1.2 })
  local legend = { { '2020', PURPLE }, { 'P3', ACCENT }, { '709', TEAL } }
  local legend_w = 0
  for _, item in ipairs(legend) do legend_w = legend_w + width(item[1], 11, true) + 10 end
  local title_right = layout.x0 + 14 + width(title, 13, true)
  local rx = badge_left - 8
  if rx - legend_w > title_right + 8 then
    for i = #legend, 1, -1 do
      local label, color = legend[i][1], legend[i][2]
      rx = rx - width(label, 11, true)
      text(rx, layout.y0 + 18, 4, 11, color, label, { bold = true, border = 1 })
      rx = rx - 10
    end
  end
  local stops = pq == 1
    and { { 10000, '10k' }, { 4000, '4k' }, { 1000, '1k' }, { 203, '203' }, { 100, '100' }, { 10, '10' }, { 1, '1' } }
    or { { 1, '100' }, { 0.75, '75' }, { 0.5, '50' }, { 0.25, '25' }, { 0, '0' } }
  for _, stop in ipairs(stops) do
    local code = pq == 1 and pq_code(stop[1]) or stop[1]
    local y = layout.wf_y + layout.wf_h * (1 - code)
    text(layout.wf_x - 4, y, 6, 11, (pq == 1 and stop[1] == 203) and ACCENT or MUTED, stop[2], { border = 1 })
  end
end

local function draw_stats()
  if not cards_visible() then return end
  local y = 22
  if has_stat('video') then y = y + draw_video_card(MARGIN, y, STATS_W) + 8 end
  if has_stat('timing') then y = y + draw_timing_card(MARGIN, y, STATS_W) + 8 end
  if has_stat('audio') then y = y + draw_audio_card(MARGIN, y, STATS_W) + 8 end
  if has_stat('network') then draw_network_card(MARGIN, y, STATS_W) end
  if has_stat('scope') then draw_scope_card() end
end

local last_shade, last_main

draw = function()
  if not session then return end
  out = {}
  local menu = state.menu
  local shaded = (state.osd and not menu) and 'osd' or (menu and 'menu') or ''
  if shaded ~= last_shade then
    last_shade = shaded
    shade.res_x, shade.res_y = res_x, res_y
    if shaded == 'osd' then
      shade.data = string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\blur60\\1c&H%s&\\1a&H38&\\p1}%s{\\p0}', BLACK,
        rounded(-80, res_y - 280, res_x + 80, res_y + 80, 0))
    elseif shaded == 'menu' then
      shade.data = string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H%s&\\1a&H70&\\p1}%s{\\p0}', BLACK,
        rounded(0, 0, res_x, res_y, 0))
    else
      shade.data = ''
    end
    shade:update()
  end
  if menu then
    if menu.kind == 'tracks' then draw_tracks(menu) else draw_playback(menu) end
  else
    if state.osd then draw_osd() end
    if state.next_card and session.next then draw_next_card()
    elseif state.prompt and session.markers[state.prompt] then draw_prompt() end
    if loading_next then
      draw_center(S('osd.loadingNext'))
    elseif props.buffering then
      local body = S('osd.buffering', { n = math.floor(props.cache) })
      draw_center(net.rate and body .. '  ·  ' .. rate_text(net.rate) or body)
    end
  end
  draw_stats()
  if state.stop_armed then draw_stop_hint()
  elseif state.toast then draw_toast() end
  local data = table.concat(out, '\n')
  if data ~= last_main then
    last_main = data
    main.res_x, main.res_y = res_x, res_y
    main.data = data
    main:update()
  end
  sync_scope_shader()
end

-- Input --------------------------------------------------------------------------------------------

-- A complex binding that acts on press and repeats, on its own clock, while held.
local function holdable(name, action)
  local timer, count
  local function stop()
    if timer then timer:kill() end
    timer = nil
  end
  mp.add_key_binding(nil, name, function(event)
    if event.event == 'press' then
      stop()
      action(0)
    elseif event.event == 'down' then
      stop()
      count = 0
      action(0)
      timer = mp.add_timeout(HOLD_DELAY, function()
        timer = mp.add_periodic_timer(HOLD_INTERVAL, function()
          count = count + 1
          -- A lost key-up must not scrub forever.
          if count * HOLD_INTERVAL > 60 then return stop() end
          action(count)
        end)
      end)
    elseif event.event == 'up' then
      stop()
    end
  end, { complex = true })
end

local function on_press(name, action)
  mp.add_key_binding(nil, name, function(event)
    if event.event == 'press' or event.event == 'down' then action() end
  end, { complex = true })
end

local function commit_scrub()
  if not state.scrub then return end
  mp.commandv('seek', string.format('%.3f', state.scrub), 'absolute')
end

local function scrub(direction, count)
  if not props.pos then return end
  local step = count < 6 and 10 or count < 16 and 30 or 60
  local limit = props.duration and props.duration - 1 or math.huge
  state.scrub = math.max(0, math.min(limit, position() + direction * step))
  if scrub_timer then scrub_timer:kill() end
  scrub_timer = mp.add_timeout(SCRUB_SETTLE, commit_scrub)
  show_osd()
end

local function direction(dx, dy)
  return function(count)
    if not session or loading_next then return end
    if state.menu then
      menu_move(dx, dy)
      draw()
    elseif dx ~= 0 then
      scrub(dx, count)
    elseif count == 0 then
      show_osd()
    end
  end
end

holdable('left', direction(-1, 0))
holdable('right', direction(1, 0))
holdable('up', direction(0, -1))
local last_down = 0
holdable('down', function(count)
  if not session or loading_next then return end
  if state.menu then
    menu_move(0, 1)
    draw()
    return
  end
  if count ~= 0 then return end
  local now = mp.get_time()
  if now - last_down < 0.08 then return end
  last_down = now
  if state.next_card then
    cancel_next()
  elseif state.osd then
    if hide_timer then hide_timer:kill() end
    state.osd = false
    draw()
  elseif state.prompt then
    state.dismissed[state.prompt] = true
    state.prompt = nil
    draw()
  end
end)
holdable('seek-back', function(count) if session and not state.menu then scrub(-1, count) end end)
holdable('seek-forward', function(count) if session and not state.menu then scrub(1, count) end end)

on_press('confirm', function()
  if not session or loading_next then return end
  if state.menu then
    menu_confirm()
  elseif state.next_card then
    play_next()
  elseif state.prompt then
    skip_marker(session.markers[state.prompt])
  else
    mp.set_property_bool('pause', not props.paused)
    show_osd()
  end
  draw()
end)

mp.add_key_binding(nil, 'back', function(event)
  if not session or quitting then return end
  if event.event == 'up' then
    if state.stop_releasing then
      state.stop_releasing = false
      return quit()
    end
    return
  end
  if event.event ~= 'press' and event.event ~= 'down' then return end
  if state.menu then
    close_menu()
  elseif state.stop_armed then
    if event.event == 'press' then return quit() end
    -- Act on button release so the physical B button is no longer held during the window handoff.
    state.stop_armed, state.stop_releasing = false, true
    mp.set_property_bool('pause', true)
    show_curtain()
    if stop_timer then stop_timer:kill() end
    stop_timer = mp.add_timeout(0.4, quit)
  elseif not loading_next then
    arm_stop()
  end
  draw()
end, { complex = true })

on_press('play-pause', function()
  if not session or loading_next then return end
  mp.set_property_bool('pause', not props.paused)
  show_osd()
end)

on_press('stop', quit)

local function chapter(step)
  if not session or state.menu or loading_next then return end
  local chapters = mp.get_property_number('chapters', 0)
  if chapters == 0 then return toast(S('osd.noChapters')) end
  mp.commandv('add', 'chapter', step)
  show_osd()
end

on_press('prev-chapter', function() chapter(-1) end)
on_press('next-chapter', function() chapter(1) end)

on_press('tracks', function()
  if not session or loading_next then return end
  if state.menu and state.menu.kind == 'tracks' then close_menu() else open_tracks() end
  draw()
end)

on_press('menu', function()
  if not session or loading_next then return end
  if state.menu and state.menu.kind == 'playback' then close_menu() else open_playback() end
  draw()
end)

local last_stats = 0
on_press('stats', function()
  if not session or loading_next or quitting then return end
  local now = mp.get_time()
  if now - last_stats < 0.08 then return end
  last_stats = now
  state.stats = not state.stats
  draw()
end)

-- Session ------------------------------------------------------------------------------------------

local function load_session(file)
  local handle = file and io.open(file, 'r')
  if not handle then
    msg.error('no session file: ' .. tostring(file))
    return mp.commandv('quit', '3')
  end
  local body = handle:read('*a')
  handle:close()
  os.remove(file)
  local parsed = utils.parse_json(body)
  if type(parsed) ~= 'table' or not parsed.url then
    msg.error('unreadable session file')
    return mp.commandv('quit', '3')
  end
  local dir = file and file:match('^(.*)/')
  if dir and dir ~= '' then run_dir = dir end
  session = parsed
  final_credits = nil
  for _, marker in ipairs(session.markers or {}) do
    if marker.kind == 'credits' then final_credits = marker end
  end
  state.menu, state.prompt, state.scrub, state.next_card, state.next_cancelled = nil, nil, nil, nil, false
  state.dismissed, state.skipped, state.stop_armed, state.stop_releasing = {}, {}, false, false
  props.pos, props.duration, props.eof = session.start, nil, false
  -- Sections persist for the process; the next episode must not reset the viewer's choice or the HUD.
  if stats_sections == nil then
    stats_sections = { video = false, timing = false, audio = false, network = false, scope = false }
    local list = session.statsSections
    if type(list) ~= 'table' then
      for _, name in ipairs(STATS_ORDER) do stats_sections[name] = true end
    else
      for _, name in ipairs(list) do
        if stats_sections[name] ~= nil then stats_sections[name] = true end
      end
    end
  end
  net.samples, net.sum, net.count, net.rate, net.last = {}, 0, 0, nil, nil
  mp.set_property_native('http-header-fields', session.httpHeaders or {})
  mp.set_property_bool('pause', true)
  show_curtain()
  local options = { ['force-media-title'] = session.title or '' }
  if session.start and session.start > 0 then options.start = string.format('%.3f', session.start) end
  mp.command_native({ name = 'loadfile', url = session.url, flags = 'replace', options = options })
end

mp.register_script_message('load', load_session)

-- gamescope switches refresh rates only while the focused window presents frames; a full-screen
-- black curtain with an imperceptible 1x1 pixel toggle forces vo=gpu-next to present frames while
-- masking the panel's mode-switch blanking.
mp.register_script_message('pulse', function(mode)
  if mode == 'stop' then
    hide_curtain()
  else
    show_curtain()
  end
end)

mp.register_event('file-loaded', function()
  if not session then return end
  if loading_next then
    loading_next = false
    if next_timer then next_timer:kill() end
  end
  apply_selection()
  draw()
end)

mp.register_event('playback-restart', function()
  if state.scrub then
    state.scrub = nil
    draw()
  end
end)

mp.observe_property('time-pos', 'number', function(_, value)
  if value then props.pos = value end
  update_markers()
end)

mp.observe_property('duration', 'number', function(_, value)
  props.duration = value
  if session and not session.bitrate and value and value > 0 then
    local size = session.fileSize or mp.get_property_number('file-size')
    if size and size > 0 then
      session.bitrate = math.floor((size * 8) / value / 1000 + 0.5)
    end
  end
end)

mp.observe_property('pause', 'bool', function(_, value)
  props.paused = value
  if not value and not quitting then hide_curtain() end
  if state.osd then arm_hide() end
  draw()
end)

mp.observe_property('paused-for-cache', 'bool', function(_, value)
  props.buffering = value
  draw()
end)

mp.observe_property('cache-buffering-state', 'number', function(_, value)
  props.cache = value or 0
end)

mp.observe_property('eof-reached', 'bool', function(_, value)
  props.eof = value
  if not value or not session or loading_next then return end
  if session.next and not state.next_cancelled then
    if session.autoplayNext then return play_next() end
    state.next_card = state.next_card or { remaining = nil }
    draw()
  else
    quit()
  end
end)

mp.observe_property('osd-dimensions', 'native', function(_, dims)
  if dims and dims.w and dims.h and dims.w > 0 and dims.h > 0 then
    res_x, res_y = math.floor(HEIGHT * dims.w / dims.h + 0.5), HEIGHT
    last_shade, last_main = nil, nil
    draw()
  end
end)

mp.add_periodic_timer(TICK, function()
  local card = state.next_card
  if card and card.remaining and not props.paused and not loading_next then
    card.remaining = card.remaining - TICK
    if card.remaining <= 0 then return play_next() end
  end
  if state.osd or card or props.buffering or state.stats then draw() end
end)

mp.add_periodic_timer(SAMPLE_INTERVAL, sample_network)

load_session(mp.get_opt('playdeck-session'))
