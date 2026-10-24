import { describe, expect, it } from 'vitest';
import { LOCALES, resolveLocale, translator } from '../src/core/i18n';
import { en } from '../src/core/i18n/en';
import { pickNext, type Rect } from '../src/ui/focus/spatial';

describe('i18n', () => {
  it('has every English message in every locale, with the same placeholders', () => {
    for (const [locale, { messages }] of Object.entries(LOCALES)) {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(messages[key], `${locale} ${key}`).toBeTruthy();
        expect(placeholders(messages[key]), `${locale} ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it('resolves the system language and fills placeholders', () => {
    expect(resolveLocale('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'de-DE')).toBe('en');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(translator('zh-CN')('servers.local', { latency: 12 })).toBe('局域网 · 12 ms');
  });
});

const box = (left: number, top: number, width = 100, height = 50): Rect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('spatial navigation', () => {
  //  [a] [b] [c]
  //  [d]     [e]
  const a = box(0, 0);
  const b = box(120, 0);
  const c = box(240, 0);
  const d = box(0, 80);
  const e = box(240, 80);
  const all = [a, b, c, d, e];

  it('moves to the nearest neighbour in a row', () => {
    expect(pickNext(a, all, 'right')).toBe(1);
    expect(pickNext(b, all, 'left')).toBe(0);
  });

  it('prefers an aligned element over a closer diagonal one', () => {
    expect(pickNext(c, all, 'down')).toBe(4);
    expect(pickNext(d, all, 'up')).toBe(0);
  });

  it('falls back to a diagonal element below when nothing is aligned', () => {
    expect(pickNext(b, all, 'down')).toBe(3);
  });

  it('treats the end of a row as an edge', () => {
    expect(pickNext(d, all, 'right')).toBe(4);
    expect(pickNext(e, [a, b, c, d, e, box(360, 200)], 'right')).toBe(-1);
  });

  it('never skips a nearer row of narrow tabs for an aligned row behind it', () => {
    const episode = box(300, 450, 300, 170);
    const tabs = [box(48, 394, 75, 40), box(131, 394, 84, 40)];
    const buttons = [box(38, 250, 120, 52), box(170, 250, 170, 52)];
    expect(pickNext(episode, [...buttons, ...tabs], 'up')).toBe(3);
  });

  it('does not take a shorter neighbour in a top-aligned row for the row above', () => {
    const tall = box(430, 190, 370, 540);
    const short = box(820, 190, 370, 150);
    const above = box(330, 40, 300, 170);
    expect(pickNext(tall, [short, above], 'up')).toBe(1);
    expect(pickNext(short, [tall], 'down')).toBe(-1);
  });

  it('stops at the edge', () => {
    expect(pickNext(c, all, 'right')).toBe(-1);
    expect(pickNext(a, all, 'up')).toBe(-1);
  });

  it('wraps vertically between the topmost and bottommost rows when enabled', () => {
    expect(pickNext(a, all, 'up', true)).toBe(3);
    expect(pickNext(c, all, 'up', true)).toBe(4);
    expect(pickNext(d, all, 'down', true)).toBe(0);
    expect(pickNext(e, all, 'down', true)).toBe(2);
    // Single row does not wrap onto itself vertically.
    expect(pickNext(a, [a, b, c], 'up', true)).toBe(-1);
    expect(pickNext(a, [a, b, c], 'down', true)).toBe(-1);
  });
});
