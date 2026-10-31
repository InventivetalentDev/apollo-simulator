# Apollo 11 Guidance Computer, in the browser

A web app that runs the **original Apollo 11 flight software** on an emulated
Apollo Guidance Computer (AGC), with a working DSKY (the crew's display and
keyboard) and a live view of the 1969 source code as it executes.

![The simulator running the Lunar Module software during a lamp test](docs/screenshot-desktop.png)

The source is not translated or rewritten. The page loads the original
`.agc` files from [chrislgarry/Apollo-11](https://github.com/chrislgarry/Apollo-11),
assembles them in the browser into the 36 banks of core rope, and runs that
rope instruction by instruction:

| Program          | Spacecraft                 | Assembled rope vs. the 1969 listing |
| ---------------- | -------------------------- | ----------------------------------- |
| **Luminary 099** | Lunar Module *Eagle*       | 36,864 of 36,864 words identical    |
| **Comanche 055** | Command Module *Columbia*  | 36,864 of 36,864 words identical    |

## Running it

You need Node.js 20 or later.

```sh
git submodule update --init   # fetches the original source into vendor/Apollo-11
npm install
npm run dev                   # http://localhost:5173
```

Other commands:

```sh
npm test                      # assembler + emulator tests (about 5 s)
npm run build                 # static site in dist/, deployable to any static host
npm run assemble -- Comanche055 --compare   # assemble from the command line, compare with the 1969 listing
```

## Deploying

Every push to `main` runs the tests, builds the site and deploys it to
<https://apollosim.app> with GitHub Actions (`.github/workflows/deploy.yml`).
The site is a Cloudflare Worker that serves the static files in `dist/`
(`wrangler.jsonc`). The workflow needs two repository secrets:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Trying the DSKY

Click the keys or type on your keyboard: digits, `V` (VERB), `N` (NOUN),
`Enter` (ENTR), `C` (CLR), `P` (PRO), `K` (KEY REL), `R` (RSET). The
"Try it" panel has ready-made sequences:

| Keys                  | What it does                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `V35E`                | Lamp test                                                               |
| `V05N09E`             | Show alarm codes (01107 at power-up: erasable memory was blank)         |
| `V16N65E`             | Monitor the clock                                                       |
| `V37E00E`             | Change major mode to P00                                                |
| `V11N01E 25E`         | Monitor a memory word (address 25 is TIME1)                             |
| `V21N27E 10E`         | Run the AGC's built-in self-check                                       |

<img src="docs/screenshot-phone.png" alt="The simulator on a phone" width="300" />

## How it works

```
vendor/Apollo-11/          original source (git submodule, public domain)
src/yul/                   the assembler
src/agc/                   the AGC emulator and the DSKY interface
src/ui/                    the web page
test/                      tests, and the 1969 octal listings used to check the assembler
```

**Assembler (`src/yul`).** A TypeScript implementation of the MIT YUL
assembler's Block II language: basic and extracode instructions, the
interpretive language (opcode pairs, indexed operands, `STADR`, switch and
shift operands), and the pseudo-operations (`SETLOC`, `BANK`, `EBANK=`,
`SBANK=`, `2CADR`, `BBCON`, `2DEC`, …), including the bank checksum
("bugger") words. It runs in a Web Worker and takes about 0.6 s for each
program. The tests compare every word of the output with transcriptions of the
octal listings printed in July 1969 (`test/fixtures/*.binsource`, public
domain, from the Virtual AGC project).

**Emulator (`src/agc`).** Implements 15-bit ones'-complement arithmetic,
16-bit A/L/Q registers with overflow, banked erasable and fixed memory with
the superbank, all instructions and extracodes, interrupts, the TIME1–TIME6
counters, I/O channels, the DSKY relay words, and the hardware alarms (night
watchman, rupt lock, TC trap) that force a restart. The flight software's own
self-check (`V21N27E 10E`) passes: the instruction tests, the erasable memory
test, and checksums of all 36 rope banks.

**Web page (`src/ui`).** The DSKY, a listing of the source in the 1969 format
(location, octal words, source line), and the computer's state. "Follow: Jobs"
tracks the code the Executive is running: key in a verb and the listing jumps
into PINBALL, the DSKY program. Inside the interpreter it shows the interpretive
instruction being executed. Lines that ran in the last moment get a green
marker. Each line number, the file name and the "Running" location link to the
same line in chrislgarry/Apollo-11 on GitHub, at the commit checked out in
`vendor/Apollo-11`, so the line numbers always match.

Both pieces were written for this project. The Virtual AGC project's yaYUL
and yaAGC (GPL) were the reference for the exact behaviour of the assembler
and of the hardware. No code was copied from them.

## Notes on the upstream source

The submodule is used unmodified. Two kinds of problem in the upstream copy
are handled when the source is loaded (see `src/programs.ts`):

- **Luminary099 include names.** Upstream renamed
  `LAMBERT_AIMPOINT_GUIDANCE.agc` and `TRIM_GIMBAL_CNTROL_SYSTEM.agc`
  without updating `MAIN.agc`, so the loader maps the old names to the new
  files.
- **Comanche055 transcription errors.** Four lines differ from the 1969
  listing. Each is corrected at load time and marked in amber in the listing:
  - a comment line in `ERASABLE_ASSIGNMENTS.agc` lost its `#`, which shifts `ALTVAR` by one word
  - the label `ZEROERROR` should be `ZEROEROR`
  - the label `GETDLEWD` should be `GETLEWD`
  - `2DEC 1.08-2` should be `2DEC 1.0 B-2`

The assembler also accepts `+n` location notes that have drifted one tab stop
to the right in a few upstream lines.

## Not simulated yet

The computer is complete; the spacecraft around it is not. There is no IMU,
optics, rendezvous or landing radar, engine, RCS jets or hand controllers, so
programs that need sensor data (for example P63, the powered descent) start
and then wait. Possible next steps:

- a simple spacecraft model feeding the IMU CDUs, PIPAs and radar counters
- an FDAI (attitude ball) and the 8-ball/cross-pointer displays
- decoding the digital downlink (telemetry) the software sends 50 times a second
- scenarios, such as the Apollo 11 descent with its 1201 and 1202 alarms
- deploying the static build (for example to GitHub Pages)
