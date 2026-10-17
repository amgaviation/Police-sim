/** Common payload of every `npc:*` event: the actor, its person (-1 for an animal) and its call (0 none). */
export interface NpcActorEvent {
  actorId: number;
  personId: number;
  callId: number;
}

/** A runner was brought down. */
export interface NpcCaughtEvent extends NpcActorEvent {
  by: 'tackle' | 'taser' | 'fight';
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
  }
}
