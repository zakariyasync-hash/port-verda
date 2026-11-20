# port-verda

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/zakariyasync-hash/port-verda/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/zakariyasync-hash/port-verda/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

Port Verda is a 2D top-down open-world crime game in a fictional harbour city. You play Raka, a harbour courier working for the fixer Mira while the Harbor Kings gang moves against you: explore the city on foot and by car, steal and drive cars, dodge the police as your wanted level rises, fight with fists and a pistol, and run six story missions plus two side jobs. Everything is original — its own city, characters, vehicles, story, art and sound — built with plain static files and vanilla JavaScript ES modules: no libraries, no network requests, no external assets. All art is drawn procedurally on canvas; all sound is made with WebAudio oscillators.

## Run it

```sh
node serve.ts
```

Then open http://localhost:8080 in a desktop browser and press Enter to start.

## Controls

- **WASD / Arrow keys** — walk and drive (Shift to run on foot)
- **E** — enter / exit a car (taking a driven car is car theft: +1 wanted star)
- **F** — punch
- **Mouse click** — shoot the pistol (aims at the clicked world position)
- **Shift** — handbrake while driving
- **P** — pause (progress is saved) · **M** — mute · **L** — continue the last save · **R** — restart after busted / wasted

## Missions

Six story missions from Mira, unlocked in order, plus two side jobs:

1. **Paket Pertama** — deliver a package to the Market kiosk ($50)
2. **Di Bawah Patroli** — pick up a package at the east warehouse without raising wanted above 1 ($120)
3. **Lepas Ekor** — shake a two-star police tail for 60 seconds ($200)
4. **Mobil Target** — steal the yellow Falcon GT and bring it to Darto's garage ($250)
5. **Gudang Harbor Kings** — clear four gang members out of the east warehouse ($400)
6. **Finale Pelabuhan** — carry the last package to Pier 7 at wanted 3 ($600)

Side jobs: **Taksi Pelabuhan** (ferry three passengers, $90) and **Paket Kilat** (five packages in 150 seconds, $150). Progress, money, health and completed missions are saved to localStorage, with autosave every 30 seconds.

---

Entered on [make.fun](https://make.fun/?ref=bj9tq8zt&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards
