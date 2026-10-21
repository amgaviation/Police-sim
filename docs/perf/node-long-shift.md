# Node long shift

Seed 4242, 57600 fixed steps (8.0 game hours), free patrol, officer idle at the station.
Date: 2026-10-21T21:41:25.965Z

Whole step: mean 0.408 ms, p95 0.690 ms, max 25.627 ms (wall 23.6 s).

| system | mean ms | p95 | max | share |
|---|---:|---:|---:|---:|
| traffic | 0.215 | 0.431 | 11.800 | 54.1% |
| npc | 0.040 | 0.076 | 16.014 | 10.2% |
| vehicles.pre | 0.038 | 0.076 | 12.347 | 9.5% |
| physics | 0.030 | 0.064 | 4.200 | 7.6% |
| copyPrevTransform | 0.014 | 0.023 | 8.233 | 3.4% |
| dispatch | 0.010 | 0.019 | 15.373 | 2.5% |
| vehicles.post | 0.007 | 0.016 | 4.892 | 1.9% |
| environment | 0.006 | 0.013 | 9.641 | 1.5% |
| integrateVelocity | 0.005 | 0.011 | 6.840 | 1.3% |
| scene | 0.004 | 0.013 | 8.522 | 1.0% |
| tactical | 0.004 | 0.013 | 4.073 | 0.9% |
| resources | 0.003 | 0.006 | 4.055 | 0.7% |
| backup | 0.003 | 0.005 | 8.866 | 0.7% |
| force | 0.002 | 0.004 | 2.402 | 0.6% |
| radio | 0.002 | 0.004 | 3.644 | 0.6% |
