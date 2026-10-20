import { describe, expect, it } from 'vitest';
import { PadState, joystickEventDevices, parseEvents } from '../electron/gamepad';
import { parseDisplayInfo, refreshFor } from '../electron/gamescope';

const DECK_OLED_RATES = [45, 47, 48, 49, 50, 51, 53, 55, 56, 59, 60, 62, 64, 65, 66, 68, 72, 73, 76, 77, 78, 80, 81, 82, 84, 85, 86, 87, 88, 90];

describe('refresh rate choice', () => {
  it('picks the highest panel rate that is a multiple of the frame rate', () => {
    expect(refreshFor(23.976, DECK_OLED_RATES)).toBe(72);
    expect(refreshFor(25, DECK_OLED_RATES)).toBe(50);
    expect(refreshFor(29.97, DECK_OLED_RATES)).toBe(90);
    expect(refreshFor(50, DECK_OLED_RATES)).toBe(50);
    expect(refreshFor(59.94, DECK_OLED_RATES)).toBe(60);
    expect(refreshFor(120, DECK_OLED_RATES)).toBeUndefined();
    expect(refreshFor(0, DECK_OLED_RATES)).toBeUndefined();
  });
});

function blob(value: string | Buffer): Buffer {
  const data = typeof value === 'string' ? Buffer.from(`${value}\0`) : value;
  const out = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
  out.writeUInt32LE(data.length, 0);
  data.copy(out, 4);
  return out;
}

describe('gamescope display info', () => {
  it('reads the connector, flags and valid refresh rates', () => {
    const rates = Buffer.alloc(12);
    [45, 72, 90].forEach((rate, i) => rates.writeUInt32LE(rate, i * 4));
    const flags = Buffer.alloc(4);
    flags.writeUInt32LE(0x1 | 0x2, 0);
    const body = Buffer.concat([blob('eDP-1'), blob('Valve'), blob('ANX7530 U'), flags, blob(rates)]);
    expect(parseDisplayInfo(body)).toEqual({
      connector: 'eDP-1',
      make: 'Valve',
      model: 'ANX7530 U',
      internal: true,
      hdr: true,
      vrr: false,
      refreshRates: [45, 72, 90],
    });
  });
});

describe('evdev gamepad', () => {
  it('finds joystick event devices', () => {
    const devices = [
      'I: Bus=0003 Vendor=28de Product=1205\nN: Name="Steam Deck"\nH: Handlers=kbd mouse2 event9',
      'I: Bus=0003 Vendor=28de Product=11ff\nN: Name="Microsoft X-Box 360 pad 0"\nH: Handlers=event10 js0',
    ].join('\n\n');
    expect(joystickEventDevices(devices)).toEqual(['/dev/input/event10']);
  });

  it('turns buttons, the D-pad and the stick into mpv key presses and releases', () => {
    const pad = new PadState();
    expect(pad.handle(1, 0x130, 1)).toEqual([{ key: 'GAMEPAD_ACTION_DOWN', down: true }]);
    expect(pad.handle(1, 0x130, 2)).toEqual([]);
    expect(pad.handle(1, 0x130, 0)).toEqual([{ key: 'GAMEPAD_ACTION_DOWN', down: false }]);
    expect(pad.handle(3, 0x10, -1)).toEqual([{ key: 'GAMEPAD_DPAD_LEFT', down: true }]);
    expect(pad.handle(3, 0x10, 1)).toEqual([
      { key: 'GAMEPAD_DPAD_LEFT', down: false },
      { key: 'GAMEPAD_DPAD_RIGHT', down: true },
    ]);
    expect(pad.handle(3, 0x00, 25000)).toEqual([{ key: 'GAMEPAD_LEFT_STICK_RIGHT', down: true }]);
    // Hysteresis: the stick stays held until it falls back past the lower threshold.
    expect(pad.handle(3, 0x00, 17000)).toEqual([]);
    expect(pad.handle(3, 0x00, 10000)).toEqual([{ key: 'GAMEPAD_LEFT_STICK_RIGHT', down: false }]);
    expect(pad.releaseAll()).toEqual([{ key: 'GAMEPAD_DPAD_RIGHT', down: false }]);
  });

  it('parses 64-bit input_event records', () => {
    const chunk = Buffer.alloc(48);
    chunk.writeUInt16LE(1, 16);
    chunk.writeUInt16LE(0x131, 18);
    chunk.writeInt32LE(1, 20);
    chunk.writeUInt16LE(3, 24 + 16);
    chunk.writeUInt16LE(0x11, 24 + 18);
    chunk.writeInt32LE(-1, 24 + 20);
    const events: number[][] = [];
    parseEvents(chunk, (type, code, value) => events.push([type, code, value]));
    expect(events).toEqual([
      [1, 0x131, 1],
      [3, 0x11, -1],
    ]);
  });
});
