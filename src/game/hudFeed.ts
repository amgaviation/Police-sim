import { createGameTime } from '../environment/time';
import { districtLabel as modDistrictLabel } from '../mods/registry';
import { createWeatherState } from '../environment/weather';
import type { Binding } from '../input/bindings';
import { PLAYER_MODE_NAMES } from '../player/mode';
import type { HudSnapshot } from '../ui/hud/hud';
import type { HudWear } from '../ui/hud/phase7';
import { DISTRICT_NAMES, EDGE_FLAG } from '../world/ids';
import type { RoadEdge, RoadGraph, RoadHit } from '../world/roadGraph';
import type { GameSession, InteractHint } from './session';

/** Search radius for the street shown on the HUD (m); further away only the district shows. */
export const HUD_ROAD_RADIUS = 15;

/** Display name of a district id: 'downtown' -> 'Downtown'. */
export function districtLabel(district: number): string {
  const name = modDistrictLabel(DISTRICT_NAMES[district] ?? 'unknown');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Short key name for a prompt: 'KeyE' -> 'E', 'Digit1' -> '1', 'Space' stays; the first keyboard binding wins. */
export function keyLabel(bindings: readonly Binding[]): string {
  const code = bindings.find((b) => b.device === 'keyboard')?.code;
  if (code === undefined) return '?';
  return /^(?:Key|Digit)(\w)$/.exec(code)?.[1] ?? code;
}

/** HUD line for what `interact` would do. */
export function interactPrompt(hint: InteractHint, key: string): string | null {
  switch (hint) {
    case 'enter':
      return `${key}  Enter vehicle`;
    case 'exit':
      return `${key}  Exit vehicle`;
    case 'refuel':
      return `${key}  Refuel`;
    case 'repair':
      return `${key}  Repair and refuel`;
    case 'trunk':
      return `${key}  Open trunk`;
    case 'driver':
      return `${key}  Talk to the driver`;
    case 'talk':
      return `${key}  Talk`;
    case 'cage':
      return `${key}  Place in rear seat`;
    case 'enterBuilding':
      return `${key}  Enter building  ·  hold ${key}: door options`;
    case 'exitBuilding':
      return `${key}  Exit building`;
    case 'door':
      return `${key}  Open / close door  ·  hold ${key}: options`;
    case 'locked':
      return `${key}  Locked door: options`;
    case 'switch':
      return `${key}  Lights on / off`;
    case 'locker':
      return `${key}  Locker`;
    case 'briefing':
      return `${key}  Briefing`;
    case 'armory':
      return `${key}  Armory`;
    case 'evidence':
      return `${key}  Deposit evidence`;
    case 'reportDesk':
      return `${key}  Report desk (MDT)`;
    case 'interview':
      return `${key}  Interview room`;
    case 'cell':
      return `${key}  Holding cell`;
    case 'collect':
      return `${key}  Collect evidence`;
    case 'fleet':
      return `${key}  Fleet garage`;
    default:
      return null;
  }
}

/**
 * Fills one reused `HudSnapshot` from the session: mode, telemetry, time, weather, the
 * nearest street with its district and limit right now, the prompt and camera mode.
 * Call at the HUD rate (it builds the road line string).
 */
export class HudFeed {
  readonly snapshot: HudSnapshot = {
    mode: 'onFoot',
    telemetry: null,
    time: createGameTime(),
    weather: createWeatherState(),
    roadName: '',
    speedLimitMph: 0,
    schoolZoneActive: false,
    construction: false,
    prompt: null,
    cameraMode: 'onFoot',
    headlights: false,
  };
  private readonly wear: HudWear = { oil: 1, tread: 1 };
  private readonly hit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
  private readonly at = { x: 0, z: 0 };
  /** The street shown last (-1 none) and its graph: kept while the player is still on it. */
  private edge = -1;
  private graph: RoadGraph | null = null;

  fill(session: GameSession, cameraMode: string, prompt: string | null): HudSnapshot {
    const s = this.snapshot;
    const env = session.env;
    // The driven vehicle, or the drone while piloting it (the speed panel shows its telemetry).
    const vehicle = session.controlledVehicle;
    s.mode = PLAYER_MODE_NAMES[session.modes.mode] ?? 'onFoot';
    s.telemetry = vehicle ? vehicle.telemetry : null;
    this.fillPhase7(s, session, vehicle);
    s.time = env.time;
    s.weather = env.weather;
    s.prompt = prompt;
    s.cameraMode = cameraMode;
    s.headlights = vehicle?.headlights ?? false;

    const at = session.playerPosition(this.at);
    const city = session.city;
    const graph = city.graph;
    const district = districtLabel(city.districtAt(at.x, at.z));
    const hit = this.roadAt(graph, at.x, at.z);
    if (!hit) {
      s.roadName = district;
      s.speedLimitMph = 0;
      s.schoolZoneActive = false;
      s.construction = false;
      return s;
    }
    const edge = graph.edges[hit.edge] as RoadEdge;
    s.roadName = `${edge.name} · ${district}`;
    s.speedLimitMph = graph.effectiveSpeedLimitMph(edge.id, env.time);
    s.schoolZoneActive = graph.isSchoolZoneActive(edge.id, env.time);
    s.construction = (edge.flags & EDGE_FLAG.construction) !== 0;
    return s;
  }

  /** Phase 7 additions: wear chips, altitude, the drone battery, the fleet chip and the gear warning. */
  private fillPhase7(s: HudSnapshot, session: GameSession, vehicle: GameSession['drivenVehicle']): void {
    if (vehicle) {
      const t = vehicle.telemetry;
      this.wear.oil = t.oilFraction;
      this.wear.tread = t.treadMin;
      s.wear = this.wear;
      const craft = vehicle.model.craft;
      s.altitude = craft !== null && craft.maxAltitudeM > 0 ? t.altitudeM : null;
      s.battery = session.remote ? t.fuelFraction : null;
    } else {
      s.wear = null;
      s.altitude = null;
      s.battery = null;
    }
    const open = session.fleet.incidents().find((i) => !i.reported && !i.charged);
    s.fleet = open ? `${open.unitId} · damage report due` : session.remote ? 'DRONE · = recalls' : null;
    s.gearWarning = session.phase7.gearWarning()?.text ?? null;
  }

  /**
   * The street under (x, z): the one shown last while the point is still on its road or sidewalk,
   * else the nearest centreline. Near a junction the cross street's centreline is closer than the
   * own one from an outer lane, so a plain nearest lookup would flip to it for 10-15 m.
   */
  private roadAt(graph: RoadGraph, x: number, z: number): RoadHit | null {
    let hit: RoadHit | null = null;
    const prev = this.graph === graph ? graph.edges[this.edge] : undefined;
    if (prev) {
      const h = graph.projectOnEdge(prev.id, x, z, this.hit);
      if (h.distance <= prev.width / 2 + prev.sidewalk) hit = h;
    }
    hit ??= graph.nearestEdge(x, z, HUD_ROAD_RADIUS, this.hit);
    this.graph = graph;
    this.edge = hit ? hit.edge : -1;
    return hit;
  }
}
