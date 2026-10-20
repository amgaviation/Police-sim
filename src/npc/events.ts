/** Common payload of every `npc:*` event: the actor, its person (-1 for an animal) and its call (0 none). */
export interface NpcActorEvent {
  actorId: number;
  personId: number;
  callId: number;
}

/** A runner was brought down (`force`: incapacitated or wounded by an officer's use of force, Phase 5). */
export interface NpcCaughtEvent extends NpcActorEvent {
  by: 'tackle' | 'taser' | 'fight' | 'force';
}

/** An actor attacked or threatened: a struggle began, a shot is due (Phase 5), or a weapon was shown. */
export interface NpcAttackEvent extends NpcActorEvent {
  kind: 'fight' | 'fire' | 'brandish';
}

/** An actor let go of a weapon at (x, z); the scene turns it into a ground item. */
export interface NpcWeaponDroppedEvent extends NpcActorEvent {
  item: string;
  x: number;
  z: number;
}

/** An actor noticed something (design §8.1): `alert` turns it towards the source, `aware` carries the rolled reaction. */
export interface NpcAwareEvent extends NpcActorEvent {
  level: 'alert' | 'aware';
  reaction: 'none' | 'hide' | 'flee' | 'confront' | 'surrender' | 'arm';
  cause: 'sound' | 'sight' | 'light';
}

declare module '../core/event-map' {
  interface EventMap {
    'npc:fled': NpcActorEvent;
    'npc:caught': NpcCaughtEvent;
    'npc:escaped': NpcActorEvent;
    'npc:surrendered': NpcActorEvent;
    'npc:attack': NpcAttackEvent;
    'npc:weaponDropped': NpcWeaponDroppedEvent;
    'npc:left': NpcActorEvent;
    'npc:revealed': NpcActorEvent;
    'npc:aware': NpcAwareEvent;
  }
}
