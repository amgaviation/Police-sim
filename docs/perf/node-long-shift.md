# Node long shift

Seed 4242, 57600 fixed steps (8.0 game hours), free patrol, officer idle at the station.
Date: 2026-10-21T19:21:24.197Z

Whole step: mean 0.717 ms, p95 1.246 ms, max 22.467 ms (wall 41.4 s).

| system | mean ms | p95 | max | share |
|---|---:|---:|---:|---:|
| physics | 0.281 | 0.431 | 11.278 | 40.1% |
| traffic | 0.237 | 0.431 | 11.183 | 33.8% |
| npc | 0.045 | 0.091 | 4.017 | 6.4% |
| vehicles.pre | 0.044 | 0.091 | 4.859 | 6.3% |
| copyPrevTransform | 0.015 | 0.027 | 2.663 | 2.1% |
| dispatch | 0.013 | 0.023 | 13.251 | 1.8% |
| vehicles.post | 0.012 | 0.023 | 6.771 | 1.7% |
| environment | 0.007 | 0.013 | 4.128 | 1.0% |
| integrateVelocity | 0.006 | 0.013 | 4.115 | 0.8% |
| scene | 0.005 | 0.016 | 6.004 | 0.7% |
| resources | 0.004 | 0.008 | 9.006 | 0.6% |
| tactical | 0.004 | 0.016 | 4.377 | 0.6% |
| force | 0.004 | 0.006 | 5.850 | 0.5% |
| radio | 0.003 | 0.005 | 20.817 | 0.5% |
| investigation | 0.003 | 0.006 | 4.074 | 0.5% |
