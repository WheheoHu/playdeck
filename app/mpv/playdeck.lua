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
local TICK = 0.25

-- ASS colors are BGR; alpha 00 is opaque.
local TEXT, MUTED, ACCENT = 'F5F2F2', 'A69A9A', '0DA0E5'
local SURFACE, BAR_BG, BLACK = '1D1717', '0F0B0B', '000000'
local GLYPH, GLYPH_TEXT, GLYPH_ALPHA = 'F5F2F2', '111111', '14'

local SPEEDS = { 0.5, 0.75, 1, 1.25, 1.5, 2 }

local session
local final_credits -- the last credits marker, where the next-episode card appears
local mapped = {} -- session track id -> mpv track id
local loading_next = false
local next_timer

local state = {
  osd = false,
  menu = nil,
  toast = nil,
  scrub = nil,
  prompt = nil, -- index of the marker whose skip button is shown
  dismissed = {},
  skipped = {},
  next_card = nil, -- { remaining = seconds or nil without autoplay }
  next_cancelled = false,
}

local props = { pos = nil, duration = nil, paused = true, buffering = false, cache = 0, eof = false }
local res_x, res_y = 1280, HEIGHT
local hide_timer, toast_timer, scrub_timer

local shade = mp.create_osd_overlay('ass-events')
local main = mp.create_osd_overlay('ass-events')
local measurer = mp.create_osd_overlay('ass-events')
shade.z, main.z = 0, 1
measurer.hidden, measurer.compute_bounds = true, true

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
  return kind == 'dpad' and 24 or kind == 'menu' and 34 or kind == 'lb-rb' and 72 or 26
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

local function quit()
  mp.commandv('quit')
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
local function map_tracks()
  mapped = {}
  local mpv_tracks = mp.get_property_native('track-list') or {}
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

local PLAYBACK_ROWS = {
  { label = 'osd.speed', step = step_speed, reset = function() mp.set_property_number('speed', 1) end,
    value = function() return string.format('%g×', mp.get_property_number('speed') or 1) end },
  { label = 'osd.audioDelay', step = function(d) adjust('audio-delay', d * 0.05, -5, 5) end,
    reset = function() mp.set_property_number('audio-delay', 0) end,
    value = function() return ms(mp.get_property_number('audio-delay') or 0) end },
  { label = 'osd.subtitleDelay', step = function(d) adjust('sub-delay', d * 0.1, -30, 30) end,
    reset = function() mp.set_property_number('sub-delay', 0) end,
    value = function() return ms(mp.get_property_number('sub-delay') or 0) end },
  { label = 'osd.subtitleSize', step = function(d) adjust('sub-scale', d * 0.1, 0.5, 2.5) end,
    reset = function() mp.set_property_number('sub-scale', 1) end,
    value = function() return string.format('%d%%', math.floor((mp.get_property_number('sub-scale') or 1) * 100 + 0.5)) end },
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
  state.osd = false
end

local function open_playback()
  state.menu = { kind = 'playback', cursor = 1 }
  state.osd = false
end

local function open_stop()
  state.menu = { kind = 'stop' }
  state.osd = false
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
  elseif menu.kind == 'stop' then
    quit()
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
  text(res_x - MARGIN, 36, 9, 20, TEXT, os.date('%H:%M'), { border = 1.5 })
  hints_bar({
    { 'dpad', S('osd.seek') },
    { 'lb-rb', S('osd.chapter') },
    { 'menu', S('osd.menu') },
    { 'y', S('osd.tracks') },
    { 'x', S('osd.stats') },
    { 'a', S(props.paused and 'osd.play' or 'osd.pause') },
    { 'b', S('osd.hide') },
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
  hint_row({ { 'a', S('osd.playNow') }, { 'b', S('osd.cancel') } }, x1 - 20, cy, 15)
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
  box(cx - w / 2, 28, cx + w / 2, 72, SURFACE, '10', 22)
  text(cx, 50, 5, 17, TEXT, state.toast)
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
  local pw, row_h = 560, 56
  local ph = 84 + #PLAYBACK_ROWS * row_h
  local x0 = (res_x - pw) / 2
  local y0 = (res_y - HINTS_HEIGHT - ph) / 2
  box(x0, y0, x0 + pw, y0 + ph, SURFACE, '08', 16)
  text(x0 + 32, y0 + 40, 4, 22, TEXT, S('osd.playback'), { bold = true })
  for i, row in ipairs(PLAYBACK_ROWS) do
    local ry = y0 + 68 + (i - 1) * row_h
    local focused = menu.cursor == i
    if focused then box(x0 + 16, ry, x0 + pw - 16, ry + row_h - 6, 'FFFFFF', 'E0', 10) end
    local cy = ry + (row_h - 6) / 2
    text(x0 + 32, cy, 4, 19, focused and TEXT or MUTED, S(row.label))
    local value = row.value()
    text(x0 + pw - 32, cy, 6, 19, TEXT, (focused and '‹  ' or '') .. value .. (focused and '  ›' or ''), { bold = true })
  end
  hints_bar({ { 'dpad', S('osd.adjust') }, { 'a', S('osd.reset') }, { 'b', S('osd.back') } })
end

local function draw_stop()
  local pw, ph = 520, 132
  local x0, y0 = (res_x - pw) / 2, (res_y - HINTS_HEIGHT - ph) / 2
  box(x0, y0, x0 + pw, y0 + ph, SURFACE, '08', 16)
  text(res_x / 2, y0 + ph / 2, 5, 26, TEXT, S('osd.stopTitle'), { bold = true })
  hints_bar({ { 'a', S('osd.stop') }, { 'b', S('osd.cancel') } })
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
        rounded(-80, res_y - 250, res_x + 80, res_y + 80, 0))
    elseif shaded == 'menu' then
      shade.data = string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H%s&\\1a&H70&\\p1}%s{\\p0}', BLACK,
        rounded(0, 0, res_x, res_y, 0))
    else
      shade.data = ''
    end
    shade:update()
  end
  if menu then
    if menu.kind == 'tracks' then draw_tracks(menu)
    elseif menu.kind == 'playback' then draw_playback(menu)
    else draw_stop() end
  else
    if state.osd then draw_osd() end
    if state.next_card and session.next then draw_next_card()
    elseif state.prompt and session.markers[state.prompt] then draw_prompt() end
    if loading_next then draw_center(S('osd.loadingNext'))
    elseif props.buffering then draw_center(S('osd.buffering', { n = math.floor(props.cache) })) end
  end
  if state.toast then draw_toast() end
  local data = table.concat(out, '\n')
  if data == last_main then return end
  last_main = data
  main.res_x, main.res_y = res_x, res_y
  main.data = data
  main:update()
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
holdable('down', direction(0, 1))
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

on_press('back', function()
  if not session then return end
  if state.menu then
    close_menu()
  elseif state.next_card then
    cancel_next()
  elseif state.osd then
    state.osd = false
  elseif state.prompt then
    state.dismissed[state.prompt] = true
    state.prompt = nil
  elseif not loading_next then
    open_stop()
  end
  draw()
end)

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

on_press('stats', function()
  mp.commandv('script-binding', 'stats/display-stats-toggle')
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
  session = parsed
  final_credits = nil
  for _, marker in ipairs(session.markers or {}) do
    if marker.kind == 'credits' then final_credits = marker end
  end
  state.menu, state.prompt, state.scrub, state.next_card, state.next_cancelled = nil, nil, nil, nil, false
  state.dismissed, state.skipped = {}, {}
  props.pos, props.duration, props.eof = session.start, nil, false
  mp.set_property_native('http-header-fields', session.httpHeaders or {})
  mp.set_property_bool('pause', true)
  local options = { ['force-media-title'] = session.title or '' }
  if session.start and session.start > 0 then options.start = string.format('%.3f', session.start) end
  mp.command_native({ name = 'loadfile', url = session.url, flags = 'replace', options = options })
end

mp.register_script_message('load', load_session)

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
end)

mp.observe_property('pause', 'bool', function(_, value)
  props.paused = value
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
  if state.osd or card or props.buffering then draw() end
end)

load_session(mp.get_opt('playdeck-session'))
