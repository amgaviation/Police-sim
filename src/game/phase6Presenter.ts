/**
 * Presentation of Phase 6 (design 12, 13, 15, 20.3): the backup, pursuit and command panels (non-pausing action panels over
 * the pure panel models), the negotiation dialogue, the FLIR camera and overlay, the helicopter and spike strip renderers and
 * the HUD additions. It changes the simulation only through request queues; panels and the camera never feed back.
 */
import * as THREE from 'three';
import { backupHudLines, commandChipText, postStaffingText, pursuitHudLine, pursuitHudVerdict, resourceEtaText } from '../ui/hud/phase6';
import type { HudSnapshot } from '../ui/hud/hud';
import { FlirOverlay } from '../ui/air';
import { backupPanelModel, backupPanelPick } from '../ui/backup';
import { DEFAULT_COMMAND_PANEL_STATE, applyCommandPick, commandPanelModel, commandPanelPick, type CommandPanelState } from '../ui/command';
import { DialoguePanel } from '../ui/dialogue/dialoguePanel';
import { ActionPanel, type ActionPanelModel } from '../ui/panels/actionPanel';
import { pursuitPanelModel, pursuitPanelPick } from '../ui/pursuit';
import type { UIRoot } from '../ui/ui';
import { AirRenderer, airCameraAltitude, airCameraPose, airCameraYaw, createAirCameraPose } from '../render/air';
import { SpikeRenderer } from '../render/pursuit';
import type { Renderer } from '../render/renderer';
import type { GameSession } from './session';

/** Panels refresh at most this often (ms). */
const PANEL_INTERVAL_MS = 250;

/** What the presenter needs from the app. */
export interface Phase6Host {
  session(): GameSession | null;
  /** One-off HUD line. */
  flash(text: string): void;
  /** Closes the patrol panels (trunk, equipment, scene ...) so a Phase 6 panel can take their place. */
  closePatrolPanels(): void;
  /** Camera vertical field of view of the game settings (restored when FLIR ends). */
  baseFov(): number;
}

type PanelKind = 'backup' | 'pursuit' | 'command';

const scratchTarget = new THREE.Vector3();

export class Phase6Presenter {
  readonly panel: ActionPanel;
  readonly negotiation: DialoguePanel;
  readonly flir: FlirOverlay;
  readonly air: AirRenderer | null;
  readonly spikes: SpikeRenderer | null;

  private readonly host: Phase6Host;
  private readonly renderer: Renderer | null;
  private kind: PanelKind | null = null;
  private selected = 'all';
  private commandState: CommandPanelState = DEFAULT_COMMAND_PANEL_STATE;
  private shownKey = '';
  private nextPanelMs = 0;
  private flirOnValue = false;
  private readonly pose = createAirCameraPose();
  private readonly backupLines: string[] = [];
  private negotiationRev = -1;
  private negotiationDismissed = false;

  constructor(scene: THREE.Scene | null, renderer: Renderer | null, ui: UIRoot | null, hudParent: HTMLElement | null, host: Phase6Host) {
    this.host = host;
    this.renderer = renderer;
    this.panel = new ActionPanel(ui);
    this.negotiation = new DialoguePanel(ui);
    this.flir = new FlirOverlay(renderer?.canvas ?? null, hudParent);
    this.air = scene ? new AirRenderer(scene) : null;
    this.spikes = scene ? new SpikeRenderer(scene) : null;
  }

  dispose(): void {
    this.end();
    this.flir.dispose();
    this.air?.update(null, 1);
  }

  /** Session start. */
  begin(): void {
    this.end();
  }

  /** Session end: panels and FLIR off. */
  end(): void {
    if (this.panel.isOpen) this.panel.close();
    if (this.negotiation.isOpen) this.negotiation.close();
    this.kind = null;
    this.negotiationDismissed = false;
    this.selected = 'all';
    this.commandState = DEFAULT_COMMAND_PANEL_STATE;
    this.setFlir(false);
    this.air?.update(null, 1);
    this.spikes?.update([]);
  }

  get flirOn(): boolean {
    return this.flirOnValue;
  }

  // --- Panels -----------------------------------------------------------------------------------

  openBackup(): void {
    const session = this.host.session();
    if (!session) return;
    this.selected = 'all';
    this.show('backup', session);
  }

  openPursuit(): void {
    const session = this.host.session();
    if (session) this.show('pursuit', session);
  }

  openCommand(): void {
    const session = this.host.session();
    if (!session) return;
    this.commandState = DEFAULT_COMMAND_PANEL_STATE;
    this.show('command', session);
  }

  private show(kind: PanelKind, session: GameSession): void {
    this.host.closePatrolPanels();
    this.kind = kind;
    const model = this.modelOf(kind, session);
    this.shownKey = this.keyOf(kind, session);
    this.panel.open(model, (index) => this.pick(index), () => {
      if (this.kind === kind) this.kind = null;
    });
  }

  private modelOf(kind: PanelKind, session: GameSession): ActionPanelModel {
    const p6 = session.phase6;
    switch (kind) {
      case 'backup':
        return backupPanelModel(p6.backup.officers(), this.selected);
      case 'pursuit':
        return pursuitPanelModel(p6.pursuit.menu(), p6.pursuit.hud());
      case 'command': {
        const call = this.callId(session);
        return commandPanelModel(p6.command.board(), p6.command.triage(), p6.backup.swatPhase(call), this.commandState);
      }
    }
  }

  private keyOf(kind: PanelKind, session: GameSession): string {
    const p6 = session.phase6;
    switch (kind) {
      case 'backup':
        return `${String(p6.backup.revision)}|${this.selected}`;
      case 'pursuit':
        return String(p6.pursuit.revision);
      case 'command':
        return `${String(p6.command.revision)}|${p6.backup.swatPhase(this.callId(session)) ?? '-'}|${this.commandState.submenu}|${JSON.stringify(this.commandState.plan)}`;
    }
  }

  private callId(session: GameSession): number {
    return session.cad.unit(session.dispatcher.playerCallsign)?.callId ?? 0;
  }

  private pick(index: number): void {
    const session = this.host.session();
    const kind = this.kind;
    if (!session || kind === null) return;
    const p6 = session.phase6;
    switch (kind) {
      case 'backup': {
        const pick = backupPanelPick(index, p6.backup.officers(), this.selected);
        if (pick?.select !== undefined) this.selected = pick.select;
        if (pick?.request) p6.backup.request(pick.request);
        break;
      }
      case 'pursuit': {
        const request = pursuitPanelPick(index, p6.pursuit.menu());
        if (request) p6.pursuit.request(request);
        break;
      }
      case 'command': {
        const call = this.callId(session);
        const pick = commandPanelPick(index, p6.command.board(), p6.command.triage(), p6.backup.swatPhase(call), this.commandState);
        if (pick === null) break;
        if ('kind' in pick) {
          p6.command.request(pick);
        } else this.commandState = applyCommandPick(this.commandState, pick);
        break;
      }
    }
    this.nextPanelMs = 0;
    this.shownKey = '';
  }

  /** The negotiation dialogue follows the command module's view: it opens when a negotiation starts, until the player closes it. */
  private openNegotiationView(session: GameSession, view: NonNullable<ReturnType<GameSession['phase6']['command']['negotiationView']>>): void {
    const command = session.phase6.command;
    this.negotiationRev = command.revision;
    this.negotiation.open(view, {
      say: (optionId, tone) => command.request({ kind: 'negotiate', optionId, tone }),
      action: () => undefined,
      commMode: () => undefined,
      close: () => {
        this.negotiationDismissed = true;
        command.request({ kind: 'negotiationClose' });
      },
    });
  }

  /** Per frame: refreshes the open panel (throttled) and keeps the negotiation dialogue in step with the command module. */
  updatePanels(session: GameSession, nowMs: number): void {
    const command = session.phase6.command;
    const view = command.negotiationView();
    if (view === null) {
      this.negotiationDismissed = false;
      if (this.negotiation.isOpen) this.negotiation.close();
    } else if (!this.negotiation.isOpen) {
      if (!this.negotiationDismissed) this.openNegotiationView(session, view);
    } else if (command.revision !== this.negotiationRev) {
      this.negotiationRev = command.revision;
      this.negotiation.update(view);
    }
    if (!this.panel.isOpen || this.kind === null || nowMs < this.nextPanelMs) return;
    this.nextPanelMs = nowMs + PANEL_INTERVAL_MS;
    const key = this.keyOf(this.kind, session);
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.panel.update(this.modelOf(this.kind, session));
  }

  // --- FLIR -------------------------------------------------------------------------------------

  /** `/`: toggles the air unit camera; only while an air unit is up. */
  toggleFlir(): void {
    const session = this.host.session();
    if (!session) return;
    if (this.flirOnValue) {
      this.setFlir(false);
      return;
    }
    if (session.phase6.resources.airView() === null) {
      this.host.flash('No air unit overhead');
      return;
    }
    this.setFlir(true);
  }

  private setFlir(on: boolean): void {
    if (this.flirOnValue === on) return;
    this.flirOnValue = on;
    this.flir.show(on);
    if (!on) {
      const camera = this.renderer?.camera;
      if (camera) {
        camera.fov = this.host.baseFov();
        camera.updateProjectionMatrix();
      }
    }
  }

  /**
   * While FLIR is on: puts the camera on the air unit and projects the target for the overlay. Returns true when it
   * drove the camera (the camera rig is bypassed); false (and FLIR turns itself off) when the air unit is gone.
   */
  updateFlirCamera(session: GameSession, camera: THREE.PerspectiveCamera): boolean {
    if (!this.flirOnValue) return false;
    const air = session.phase6.resources.airView();
    if (air === null) {
      this.setFlir(false);
      return false;
    }
    const pose = airCameraPose(air, this.pose);
    camera.position.set(pose.x, pose.y, pose.z);
    camera.lookAt(pose.lookX, pose.lookY, pose.lookZ);
    if (camera.fov !== pose.fov) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    const canvas = this.renderer?.canvas;
    if (canvas) {
      scratchTarget.set(air.targetX, 0, air.targetZ).project(camera);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const visible = scratchTarget.z < 1 && Math.abs(scratchTarget.x) <= 1 && Math.abs(scratchTarget.y) <= 1;
      this.flirTarget.sx = (scratchTarget.x * 0.5 + 0.5) * w;
      this.flirTarget.sy = (-scratchTarget.y * 0.5 + 0.5) * h;
      this.flirTarget.visible = visible;
    } else this.flirTarget.visible = false;
    this.flir.update(this.flirTarget, airCameraAltitude(pose), airCameraYaw(pose));
    return true;
  }

  private readonly flirTarget = { sx: 0, sy: 0, visible: false };

  // --- Render -----------------------------------------------------------------------------------

  /** Per frame: the helicopter and the spike strips. */
  updateRender(session: GameSession, alpha: number): void {
    const p6 = session.phase6;
    this.air?.update(p6.resources.airView(), alpha);
    this.spikes?.update(p6.pursuit.strips());
  }

  // --- HUD --------------------------------------------------------------------------------------

  /** Backup lines, pursuit line and verdict, resource ETA, command chip and the FLIR chip for the 10 Hz HUD. */
  fillHud(s: HudSnapshot, session: GameSession): void {
    const p6 = session.phase6;
    const board = p6.command.board();
    s.backup = backupHudLines(p6.backup.officers(), this.backupLines, postStaffingText(board));
    const pursuit = p6.pursuit.hud();
    s.pursuit6 = pursuitHudLine(pursuit);
    s.pursuitVerdict = pursuitHudVerdict(pursuit);
    s.resourceEta = resourceEtaText(p6.resources.hud());
    s.command = p6.command.hud() ?? commandChipText(board);
    s.flir = this.flirOnValue;
  }
}
