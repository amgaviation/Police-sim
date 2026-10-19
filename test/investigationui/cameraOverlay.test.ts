import { describe, expect, it, vi } from 'vitest';
import { PHOTO_FOV_DEFAULT, PHOTO_FOV_MAX, PHOTO_FOV_MIN } from '../../src/investigation/types';
import { CAMERA_FOV_STEP, CameraOverlay, createCameraState, reduceCameraKey, type CameraHandlers } from '../../src/ui/investigation';
import { asUi, fakeUi, key } from './helpers';

const info = { caseLabel: 'C-00042', room: 'Kitchen', caption: '' };

function handlers() {
  const shutter = vi.fn<(fovDeg: number) => void>();
  const fov = vi.fn<(fovDeg: number) => void>();
  const close = vi.fn<() => void>();
  const h: CameraHandlers = { shutter: (f) => shutter(f), fov: (f) => fov(f), close: () => close() };
  return { h, shutter, fov, close };
}

describe('reduceCameraKey', () => {
  it('Space and Enter take the photo at the current field of view', () => {
    const s = createCameraState();
    expect(s.fovDeg).toBe(PHOTO_FOV_DEFAULT);
    for (const k of [' ', 'Enter']) {
      const r = reduceCameraKey(s, k);
      expect(r.emit).toEqual({ kind: 'shutter', fovDeg: PHOTO_FOV_DEFAULT });
      expect(r.consumed).toBe(true);
    }
  });

  it('zooms in and out in steps and clamps at the limits', () => {
    let s = createCameraState();
    s = reduceCameraKey(s, 'ArrowUp').state;
    expect(s.fovDeg).toBe(PHOTO_FOV_DEFAULT - CAMERA_FOV_STEP);
    expect(reduceCameraKey(s, '+').state.fovDeg).toBe(PHOTO_FOV_DEFAULT - 2 * CAMERA_FOV_STEP);
    expect(reduceCameraKey(s, 'ArrowDown').state.fovDeg).toBe(PHOTO_FOV_DEFAULT);
    for (let i = 0; i < 40; i++) s = reduceCameraKey(s, 'ArrowUp').state;
    expect(s.fovDeg).toBe(PHOTO_FOV_MIN);
    expect(reduceCameraKey(s, 'ArrowUp').emit).toBeNull();
    for (let i = 0; i < 40; i++) s = reduceCameraKey(s, '-').state;
    expect(s.fovDeg).toBe(PHOTO_FOV_MAX);
  });

  it('Escape closes and other keys are not consumed', () => {
    const s = createCameraState();
    expect(reduceCameraKey(s, 'Escape')).toMatchObject({ emit: { kind: 'close' }, consumed: true });
    expect(reduceCameraKey(s, 'q')).toEqual({ state: s, emit: null, consumed: false });
  });

  it('a bad field of view falls back to the default', () => {
    expect(createCameraState(Number.NaN).fovDeg).toBe(PHOTO_FOV_DEFAULT);
    expect(createCameraState(500).fovDeg).toBe(PHOTO_FOV_MAX);
  });
});

describe('CameraOverlay (headless)', () => {
  it('is a non-pausing menu with id inv-camera', () => {
    const c = new CameraOverlay(null);
    expect(c.id).toBe('inv-camera');
    expect(c.pausesGame).toBe(false);
    expect(c.isOpen).toBe(false);
  });

  it('open tells the app the field of view; the shutter key fires once, never on repeat', () => {
    const c = new CameraOverlay(null);
    const m = handlers();
    const h = m.h;
    c.open(info, h);
    expect(m.fov).toHaveBeenCalledWith(PHOTO_FOV_DEFAULT);
    expect(c.onKeyDown(key(' '))).toBe(true);
    expect(c.onKeyDown(key(' ', true))).toBe(true);
    c.shutter();
    expect(m.shutter).toHaveBeenCalledTimes(2);
    expect(m.shutter).toHaveBeenCalledWith(PHOTO_FOV_DEFAULT);
  });

  it('zoom keys report the new field of view', () => {
    const c = new CameraOverlay(null);
    const m = handlers();
    const h = m.h;
    c.open(info, h);
    c.onKeyDown(key('ArrowUp'));
    expect(m.fov).toHaveBeenLastCalledWith(PHOTO_FOV_DEFAULT - CAMERA_FOV_STEP);
    expect(c.state.fovDeg).toBe(PHOTO_FOV_DEFAULT - CAMERA_FOV_STEP);
  });

  it('Escape closes through the handler once; close() is silent', () => {
    const c = new CameraOverlay(null);
    const m = handlers();
    const h = m.h;
    c.open(info, h);
    expect(c.onKeyDown(key('Escape'))).toBe(true);
    expect(c.isOpen).toBe(false);
    expect(m.close).toHaveBeenCalledOnce();
    expect(c.onKeyDown(key('Escape'))).toBe(false);
    const m2 = handlers();
    const h2 = m2.h;
    c.open(info, h2);
    c.close();
    c.close();
    expect(m2.close).not.toHaveBeenCalled();
    expect(m2.shutter).not.toHaveBeenCalled();
  });

  it('ignores keys with modifiers and while closed', () => {
    const c = new CameraOverlay(null);
    expect(c.onKeyDown(key(' '))).toBe(false);
    const m = handlers();
    const h = m.h;
    c.open(info, h);
    expect(c.onKeyDown({ key: ' ', repeat: false, ctrlKey: true } as KeyboardEvent)).toBe(false);
    expect(m.shutter).not.toHaveBeenCalled();
  });

  it('pushes onto the menu stack and treats being dropped as leaving camera mode', () => {
    const ui = fakeUi();
    const c = new CameraOverlay(asUi(ui));
    const m = handlers();
    const h = m.h;
    c.open(info, h);
    expect(ui.menus).toEqual([c]);
    ui.pop(c);
    expect(c.isOpen).toBe(false);
    expect(m.close).toHaveBeenCalledOnce();
  });

  it('update and dispose are safe without a DOM', () => {
    const c = new CameraOverlay(null);
    c.update(info);
    c.open(info, handlers().h);
    c.update({ ...info, caption: 'Marker 1 — Knife (Kitchen)' });
    c.dispose();
    expect(c.isOpen).toBe(false);
  });
});
