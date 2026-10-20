# Patrol — demo build

`scripts/demo.sh` builds and serves the newest completed phase (the latest `Phase N: ...` commit on this branch), so work in progress never reaches the demo.

## Run in GitHub Codespaces (browser)

```sh
gh codespace create -R amgaviation/police-sim -b claude/peaceful-bardeen-tn23af -m basicLinux32gb && gh codespace code --web -R amgaviation/police-sim
```

When the codespace attaches it runs `bash scripts/demo.sh`: install, production build, then `vite preview` on port 4173, which opens in a new browser tab. If it doesn't, open the **Ports** panel and click the globe icon next to 4173. Re-run `bash scripts/demo.sh` in the terminal to pick up a newer completed phase.

Elsewhere (Node 22+): `bash scripts/demo.sh`, then open http://localhost:4173.

## Controls (short)
New game on the title screen · WASD move/drive · E interact / enter-exit vehicle · Tab MDT/CAD · T radio menu · L lights · Q siren · P run plate · V camera · F3 perf · ` console · Esc menu
