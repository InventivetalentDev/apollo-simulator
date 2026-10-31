// The LM a few minutes before powered descent on Apollo 11, as the guidance
// computer needs it to run P63: the pre-launch pad load (the values the
// software needs for landing), the LM and CSM state vectors, an IMU aligned
// to the landing site, and the clock at mission time.
//
// Pad-load values come from the Grumman LM Data Book table "LGC Prelaunch
// Erasable Load (Luminary 99)", SNA-8-D-027(II), amended 11 June 1969
// (https://ibiblio.org/apollo/Documents/Luminary99PadLoads.pdf).  The state
// vectors are not in it (they were uplinked during the mission), so they are
// built here: a descent orbit through the landing site, with its low point
// where the burn starts, as on Apollo 11.

import type { AGC } from '../agc/cpu.ts';
import { REG } from '../agc/cpu.ts';
import { cross, matrixToQuat, type Vec3 } from './attitude.ts';
import type { LunarModule } from './lm.ts';
import { MOON_MU, moonAxes, moonFixedToInertial, moonGravity } from './moon.ts';

/** Erasable address of a symbol in the assembled program. */
export type AddressOf = (name: string) => number;

/** Resolve "NAME" or "NAME+n". */
const resolve = (address: AddressOf, name: string) => {
  const [base, offset] = name.split('+');
  return address(base) + Number(offset ?? 0);
};

const HOUR = 3600;
const MINUTE = 60;
const NMI = 1852;

/** Mission time (ground elapsed time, s) the setup puts on the computer's clock. */
export const SETUP_TIME = 102 * HOUR + 27 * MINUTE;
/** Planned landing time, 102:47:11 (TLAND as uplinked for the landing). */
export const LANDING_TIME = 102 * HOUR + 47 * MINUTE + 11;
/** Time of the descent orbit's low point: Apollo 11 ignited at 102:33:05. */
const PERILUNE_TIME = 102 * HOUR + 33 * MINUTE + 5;
/** The low point lies this far before the landing site, measured from the Moon's centre. */
const PERILUNE_UPRANGE = 15 * (Math.PI / 180);
/** Heights of the descent orbit above the landing site: 50,000 ft by 60 n mi. */
const PERILUNE_HEIGHT = 50000 * 0.3048;
const APOLUNE_HEIGHT = 60 * NMI;
/** The CSM's circular orbit, 60 n mi up, a few degrees behind the LM. */
const CSM_HEIGHT = 60 * NMI;
const CSM_BEHIND = 3 * (Math.PI / 180);
/** Descent propellant left at the start of powered descent, kg. */
export const DESCENT_PROPELLANT = 8100;

// ---- The pad load.

/**
 * The Data Book's erasable load, word for word, by symbol (with "+n" for a
 * later word of the same quantity).  Left out: the state vectors, REFSMMAT
 * and TLAND, which the setup computes for the landing; the mass, which the
 * autopilot data load (V48) sets; the IMU drift compensation terms, since the
 * simulated IMU does not drift; the lunar libration (504LM), since the
 * simulated Moon does not librate (and the table's copy is unreadable); and
 * the flag words, whose one pad-loaded bit is set below.
 */
const PAD_LOAD: [string, number[]][] = [
  ['DUMPCNT', [0o10000]], // 2 dumps
  ['E3J22R2M', [0o12160]], // 9.20479047931e16 m^5/cs^2
  ['E32C31RM', [0o03363]], // 1.31289255968e23 m^6/cs^2
  ['RADSKAL', [0o00000, 0o00000]], // 0 m/cs
  ['SKALSKAL', [0o00000]], // 0
  ['GCOMPSW', [0o00000]], // 0
  ['X789', [0o00000, 0o00000]], // 0 radians
  ['X789+2', [0o00000, 0o00000]], // 0 radians
  ['X789+4', [0o00000, 0o00000]], // 0 radians
  ['RANGEVAR', [0o01351, 0o24734]], // 1.111111111e-05 m^2
  ['RATEVAR', [0o02354, 0o04750]], // 1.877777e-05 m^2/cs^2
  ['RVARMIN', [0o00410]], // 66 m^2
  ['VVARMIN', [0o00165]], // 1.7445e-06 m^2/cs^2
  ['WRENDPOS', [0o05750]], // 3048 m
  ['WRENDVEL', [0o00763]], // 0.03048 m/cs
  ['WSHAFT', [0o17270]], // 0.015 radians
  ['WTRUN', [0o17270]], // 0.015 radians
  ['RMAX', [0o00023]], // 609.6 m
  ['VMAX', [0o00001]], // 0.006096 m/cs
  ['WSURFPOS', [0o37200]], // 16000 m
  ['WSURFVEL', [0o00754]], // 0.03 m/cs
  ['SHAFTVAR', [0o00103]], // 1e-06 rad^2
  ['TRUNVAR', [0o00103]], // 1e-06 rad^2
  ['AGSK', [0o03671, 0o21200]], // 32400000 cs
  ['RBRFG', [0o00000, 0o01506]], // 52.375308 m
  ['RBRFG+2', [0o00000, 0o00000]], // 0 m
  ['RBRFG+4', [0o77774, 0o72222]], // -3254.836061 m
  ['VBRFG', [0o77772, 0o72612]], // -0.322710048 m/cs
  ['VBRFG+2', [0o00000, 0o00000]], // 0 m/cs
  ['VBRFG+4', [0o77777, 0o76300]], // -0.00316992 m/cs
  ['ABRFG', [0o00004, 0o37445]], // 1.9022568e-05 m/cs^2
  ['ABRFG+2', [0o00000, 0o00000]], // 0 m/cs^2
  ['ABRFG+4', [0o77667, 0o50111]], // -0.000277502112 m/cs^2
  ['VBRFG*', [0o77777, 0o74261]], // -0.05705856 m/cs
  ['ABRFG*', [0o77113, 0o60670]], // -0.001665012672 m/cs^2
  ['JBRFG*', [0o77472, 0o72437]], // -5.738399496e-09 m/cs^3
  ['GAINBRAK', [0o37777, 0o37777]], // 1
  ['TCGFBRAK', [0o00567]], // 3000 cs
  ['TCGIBRAK', [0o25762]], // 90000 cs
  ['RAPFG', [0o00000, 0o01036]], // 33.858708 m
  ['RAPFG+2', [0o00000, 0o00000]], // 0 m
  ['RAPFG+4', [0o77777, 0o77574]], // -8.1668112 m
  ['VAPFG', [0o77777, 0o70152]], // -0.015218664 m/cs
  ['VAPFG+2', [0o00000, 0o00000]], // 0 m/cs
  ['VAPFG+4', [0o00000, 0o00306]], // 0.000755904 m/cs
  ['AAPFG', [0o77775, 0o74720]], // -7.997952e-06 m/cs^2
  ['AAPFG+2', [0o00000, 0o00000]], // 0 m/cs^2
  ['AAPFG+4', [0o77773, 0o75055]], // -1.560576e-05 m/cs^2
  ['VAPFG*', [0o00000, 0o00676]], // 0.013606272 m/cs
  ['AAPFG*', [0o77747, 0o56422]], // -9.363456e-05 m/cs^2
  ['JAPFG*', [0o00022, 0o35646]], // 5.50993056e-10 m/cs^3
  ['GAINAPPR', [0o00000, 0o00000]], // 0
  ['TCGFAPPR', [0o00567]], // 3000 cs
  ['TCGIAPPR', [0o04704]], // 20000 cs
  ['VIGN', [0o00416, 0o16071]], // 16.90256208 m/cs
  ['RIGNX', [0o77731, 0o44630]], // -39782.453328 m
  ['RIGNZ', [0o77125, 0o62404]], // -436655.657 m
  ['KIGNX/B4', [0o76607, 0o61356]], // -0.617631
  ['KIGNY/B8', [0o72634, 0o51602]], // -2.4770341207e-06 1/m
  ['KIGNV/B4', [0o72775, 0o57777]], // -41000 cs
  ['LOWCRIT', [0o04114]], // 2124.4 DPS throttle pulses
  ['HIGHCRIT', [0o04454]], // 2348 DPS throttle pulses
  ['V2FG', [0o77777, 0o73242]], // -0.009144 m/cs
  ['V2FG+2', [0o00000, 0o00000]], // 0 m/cs
  ['V2FG+4', [0o00000, 0o00000]], // 0 m/cs
  ['TAUVERT', [0o01750, 0o00000]], // 1000 cs
  ['DELQFIX', [0o00000, 0o01717]], // 60.96 m
  ['LRALPHA', [0o01027]], // 0.0163371759 rev
  ['LRBETA1', [0o04204]], // 0.0665287037 rev
  ['LRALPHA2', [0o01022]], // 0.0161680555 rev
  ['LRBETA2', [0o00004]], // 0.0001361111 rev
  ['LRVMAX', [0o01414]], // 6.096 m/cs
  ['LRVF', [0o00116]], // 0.6096 m/cs
  ['LRWVZ', [0o11463]], // 0.3
  ['LRWVY', [0o11463]], // 0.3
  ['LRWVX', [0o11463]], // 0.3
  ['LRWVFZ', [0o06315]], // 0.2
  ['LRWVFY', [0o06315]], // 0.2
  ['LRWVFX', [0o06315]], // 0.2
  ['LRWVFF', [0o03146]], // 0.1
  ['RODSCALE', [0o14370]], // 0.003048 m/cs
  ['TAUROD', [0o11300, 0o00000]], // 150 cs
  ['LAG/TAU', [0o15164, 0o01420]], // 0.413333
  ['MINFORCE', [0o00001, 0o27631]], // 0.4359257183 kg m/cs^2
  ['MAXFORCE', [0o00013, 0o06551]], // 2.802379618 kg m/cs^2
  ['ABTCOF', [0o01311, 0o21176]], // 2.4755856e-15 m/cs^4
  ['ABTCOF+2', [0o76401, 0o47023]], // -3.486912e-10 m/cs^3
  ['ABTCOF+4', [0o00132, 0o26223]], // 5.4059328e-06 m/cs^2
  ['ABTCOF+6', [0o04231, 0o05721]], // 17.19675504 m/cs
  ['ABTCOF+8', [0o01241, 0o32430]], // 2.337816e-15 m/cs^4
  ['ABTCOF+10', [0o76470, 0o45634]], // -3.236976e-10 m/cs^3
  ['ABTCOF+12', [0o00106, 0o22276]], // 4.2065448e-06 m/cs^2
  ['ABTCOF+14', [0o04232, 0o10573]], // 17.20525896 m/cs
  ['VMIN', [0o04147, 0o24472]], // 16.80972 m/cs
  ['YLIM', [0o00016, 0o32446]], // 15186.4 m
  ['ABTRDOT', [0o00007, 0o23346]], // 0.059436 m/cs
  ['COSTHET1', [0o00000, 0o00000]], // 0
  ['COSTHET2', [0o06733, 0o07535]], // 0.8660254037
  ['ROLLTIME', [0o05556]], // 2926 cs
  ['PITTIME', [0o04431]], // 2329 cs
  ['DKTRAP', [0o77001]], // -0.0038888888 rev/sec
  ['DKOMEGAN', [0o00012]], // 10
  ['DKKAOSN', [0o00074]], // 60
  ['LMTRAP', [0o77001]], // -0.0038888888 rev/sec
  ['LMOMEGAN', [0o00000]], // 0
  ['LMKAOSN', [0o00074]], // 60
  ['DKDB', [0o00200]], // 256 1/rev
  ['IGNAOSQ', [0o02614]], // 0.0216666667 rev/sec^2
  ['IGNAOSR', [0o00062]], // 0.0007694444 rev/sec^2
  ['DOWNTORK', [0o00000]], // 0 jet seconds
  ['DOWNTORK+1', [0o00000]], // 0 jet seconds
  ['DOWNTORK+2', [0o00000]], // 0 jet seconds
  ['DOWNTORK+3', [0o00000]], // 0 jet seconds
  ['DOWNTORK+4', [0o00000]], // 0 jet seconds
  ['DOWNTORK+5', [0o00000]], // 0 jet seconds
  ['ATIGINC', [0o00001, 0o03120]], // 18000 cs
  ['PTIGINC', [0o00001, 0o03120]], // 18000 cs
  ['AOTAZ', [0o65244]], // -0.1668666667 rev
  ['AOTAZ+1', [0o77762]], // -0.0004277778 rev
  ['AOTAZ+2', [0o12476]], // 0.1659444444 rev
  ['AOTAZ+3', [0o25247]], // 0.3332305556 rev
  ['AOTAZ+4', [0o37771]], // 0.4997944444 rev
  ['AOTAZ+5', [0o52510]], // -0.3337527778 rev
  ['AOTEL', [0o07777]], // 0.1249805556 rev
  ['AOTEL+1', [0o10006]], // 0.1251694444 rev
  ['AOTEL+2', [0o10006]], // 0.125175 rev
  ['AOTEL+3', [0o10000]], // 0.1249888889 rev
  ['AOTEL+4', [0o07772]], // 0.1248027778 rev
  ['AOTEL+5', [0o07771]], // 0.1247972222 rev
  ['LRHMAX', [0o35610]], // 15240 m
  ['LRWH', [0o13146]], // 0.35
  ['ZOOMTIME', [0o05050]], // 2600 cs
  ['TENDBRAK', [0o01407]], // 6200 cs
  ['TENDAPPR', [0o00226]], // 1200 cs
  ['DELTTFAP', [0o75240]], // -11000 cs
  ['LEADTIME', [0o77743]], // -220 cs
  ['RPCRTIME', [0o01407]], // 6200 cs
  ['RPCRTQSW', [0o57777]], // -1
  ['TNEWA', [0o20000, 0o00000]], // 134217728 cs
  ['CSMMASS', [0o10050]], // 16542.7 kg
  ['TEPHEM', [0o00000, 0o20017, 0o20500]], // 134472000 cs
  ['AZO', [0o30624, 0o01636]], // 0.7746616521 rev
  ['-AYO', [0o77777, 0o53172]], // -3.95943e-05 rev
  ['AXO', [0o00000, 0o26056]], // 4.21325e-05 rev
  ['RLS', [0o00301, 0o34760]], // 1588471.994 m
  ['RLS+2', [0o00125, 0o04627]], // 697547.4954 m
  ['RLS+4', [0o00002, 0o24342]], // 21616.9998 m
  ['HIASCENT', [0o02350]], // 5023.6 kg
];

/** Landing site, Moon-fixed, m: Tranquility Base, 0.714 deg N, 23.708 deg E (RLS). */
const PAD_LOAD_RLS: Vec3 = [1588471.994, 697547.4954, 21616.9998];
/** From 1 July 1969, 0h, to the computer's clock zero at launch, centiseconds (TEPHEM). */
const PAD_LOAD_TEPHEM = 134472000;

// ---- Vectors.

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));

/**
 * Coasting flight from mission time `from` over `seconds` (negative to go
 * back), under the Moon's gravity, by fixed-step Runge-Kutta.
 */
function coast(r: Vec3, v: Vec3, from: number, seconds: number): [Vec3, Vec3] {
  const steps = Math.ceil(Math.abs(seconds));
  const h = seconds / steps;
  const epoch = from + ephemerisOffset();
  for (let i = 0; i < steps; i++) {
    const t = epoch + i * h;
    const k1v = moonGravity(r, t);
    const k1r = v;
    const k2v = moonGravity(add(r, scale(k1r, h / 2)), t + h / 2);
    const k2r = add(v, scale(k1v, h / 2));
    const k3v = moonGravity(add(r, scale(k2r, h / 2)), t + h / 2);
    const k3r = add(v, scale(k2v, h / 2));
    const k4v = moonGravity(add(r, scale(k3r, h)), t + h);
    const k4r = add(v, scale(k3v, h));
    r = add(r, scale(add(add(k1r, scale(k2r, 2)), add(scale(k3r, 2), k4r)), h / 6));
    v = add(v, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), h / 6));
  }
  return [r, v];
}

// ---- The computer's number formats.

/**
 * A value as AGC words: the fraction value / 2^scale in ones' complement,
 * 14 bits of magnitude per word, all words carrying the sign.
 */
export function agcWords(value: number, scaleExponent: number, count: number): number[] {
  let f = value / 2 ** scaleExponent;
  if (Math.abs(f) >= 1) throw new Error(`${value} does not fit at scale 2^${scaleExponent}`);
  const negative = f < 0;
  f = Math.abs(f);
  const words: number[] = [];
  for (let i = 0; i < count; i++) {
    f *= 2 ** 14;
    const w = i === count - 1 ? Math.round(f) : Math.floor(f);
    words.push(w);
    f -= w;
  }
  for (let i = count - 1; i > 0; i--) {
    if (words[i] >= 2 ** 14) {
      words[i] -= 2 ** 14;
      words[i - 1]++;
    }
  }
  return words.map((w) => (negative ? ~w & 0o77777 : w));
}

// ---- The setup.

export interface DescentState {
  /** Landing site, Moon-fixed, m. */
  site: Vec3;
  lmPosition: Vec3;
  lmVelocity: Vec3;
  csmPosition: Vec3;
  csmVelocity: Vec3;
  /** Stable-member axes in inertial coordinates (the REFSMMAT rows). */
  platform: [Vec3, Vec3, Vec3];
}

/** Seconds from the ephemeris epoch (1 July 1969, 0h) to the computer's clock zero (TEPHEM). */
export function ephemerisOffset(): number {
  return PAD_LOAD_TEPHEM / 100;
}

/** The orbits and the platform alignment for the setup, at SETUP_TIME. */
export function descentState(): DescentState {
  const epoch = ephemerisOffset();
  const site = PAD_LOAD_RLS;
  const siteRadius = Math.hypot(...site);
  // The landing site where it will be at the landing time, and the Moon's spin axis.
  const up = unit(moonFixedToInertial(site, LANDING_TIME + epoch));
  const pole = moonAxes(LANDING_TIME + epoch)[2];
  // A retrograde orbit (flying west, against the Moon's turn) in the plane
  // through the site: its normal is the pole's opposite, made square to the site.
  const normal = unit(add(scale(pole, -1), scale(up, dot(pole, up))));
  const along = cross(normal, up); // the direction of flight over the site

  // The descent orbit's low point, uprange of the site.
  const lowDirection = add(scale(up, Math.cos(PERILUNE_UPRANGE)), scale(along, -Math.sin(PERILUNE_UPRANGE)));
  const rp = siteRadius + PERILUNE_HEIGHT;
  const ra = siteRadius + APOLUNE_HEIGHT;
  const vp = Math.sqrt(MOON_MU * (2 / rp - 2 / (rp + ra)));
  const [lmPosition, lmVelocity] = coast(scale(lowDirection, rp), scale(cross(normal, lowDirection), vp), PERILUNE_TIME, SETUP_TIME - PERILUNE_TIME);

  // The CSM in its circular orbit, a little behind.
  const lmUp = unit(lmPosition);
  const csmUp = add(scale(lmUp, Math.cos(CSM_BEHIND)), scale(cross(normal, lmUp), -Math.sin(CSM_BEHIND)));
  const rc = siteRadius + CSM_HEIGHT;
  const csmPosition = scale(csmUp, rc);
  const csmVelocity = scale(cross(normal, csmUp), Math.sqrt(MOON_MU / rc));

  // Landing-site orientation, as LSORIENT computes it for P52 option 4:
  // X through the site at landing, Z = unit((R x V of the CSM) x X), Y = Z x X.
  const x = up;
  const z = unit(cross(cross(csmPosition, csmVelocity), x));
  const y = unit(cross(z, x));
  return { site, lmPosition, lmVelocity, csmPosition, csmVelocity, platform: [x, y, z] };
}

/**
 * Put the LM's hardware in the pre-descent state: IMU platform aligned to the
 * landing site, the LM in its braking attitude (engine forward, windows down),
 * still, with its engine armed and propellant loaded.  Call this before the
 * computer's fresh start, so that the software reads the gimbal angles as it
 * starts up.
 */
export function prepareLunarModule(lm: LunarModule, state: DescentState): void {
  const [x, y, z] = state.platform;
  lm.stableMember = matrixToQuat([x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]);
  const bodyX = unit(scale(state.lmVelocity, -1)); // thrust against the flight direction
  const bodyZ = unit(add(scale(state.lmPosition, -1), scale(bodyX, dot(state.lmPosition, bodyX)))); // windows towards the Moon
  const bodyY = cross(bodyZ, bodyX);
  lm.attitude = matrixToQuat([bodyX[0], bodyY[0], bodyZ[0], bodyX[1], bodyY[1], bodyZ[1], bodyX[2], bodyY[2], bodyZ[2]]);
  lm.rate = [0, 0, 0];
  lm.orbiting = false;
  lm.landed = false;
  lm.touchdown = null;
  lm.controls.mode = 'auto';
  lm.engine.armed = true;
  lm.engine.propellant = DESCENT_PROPELLANT;
  lm.engine.counter = 0;
  lm.engine.thrust = 0;
  lm.engine.gimbal.fill(0);
  lm.resetLandingRadar();
}

/**
 * After the fresh start: set the clock, load the pad load, the state vectors
 * and REFSMMAT, and set the LM moving along its orbit.
 */
export function loadDescent(agc: AGC, lm: LunarModule, address: AddressOf, state: DescentState): void {
  const write = (name: string, value: number, scaleExponent: number, count: number, offset = 0) => {
    const at = address(name) + offset;
    agcWords(value, scaleExponent, count).forEach((w, i) => (agc.mem[at + i] = w));
  };
  const writeVector = (name: string, v: Vec3, scaleExponent: number) => v.forEach((c, i) => write(name, c, scaleExponent, 2, 2 * i));
  const zero = (name: string, count: number) => agc.mem.fill(0, address(name), address(name) + count);


  // Clock: centiseconds since clock zero, TIME2 high and TIME1 low.
  const cs = Math.round(SETUP_TIME * 100);
  agc.mem[REG.TIME2] = Math.floor(cs / 2 ** 14);
  agc.mem[REG.TIME1] = cs % 2 ** 14;

  for (const [name, words] of PAD_LOAD) words.forEach((w, i) => (agc.mem[resolve(address, name) + i] = w));
  agc.mem[address('FLAGWRD3')] |= 0o2000; // NOR29FLG, as pad-loaded: no radar designate in powered flight
  write('TLAND', LANDING_TIME * 100, 28, 2);

  // State vectors, lunar scaling: metres at 2^27, m/cs at 2^5, centiseconds at 2^28.
  for (const [vehicle, r, v] of [['LEM', state.lmPosition, state.lmVelocity], ['CSM', state.csmPosition, state.csmVelocity]] as const) {
    writeVector(`RRECT${vehicle}`, r, 27);
    writeVector(`VRECT${vehicle}`, scale(v, 0.01), 5);
    writeVector(`RCV${vehicle}`, r, 27);
    writeVector(`VCV${vehicle}`, scale(v, 0.01), 5);
    write(`TET${vehicle}`, cs, 28, 2);
    zero(`DELTA${vehicle}`, 6);
    zero(`NUV${vehicle}`, 6);
    zero(`TC${vehicle}`, 2);
    zero(`XKEP${vehicle}`, 2);
  }

  // REFSMMAT, half-unit scaled, and the flags: REFSMMAT good, both vehicles about the Moon.
  state.platform.forEach((row, i) => row.forEach((c, j) => write('REFSMMAT', c, 1, 2, 6 * i + 2 * j)));
  agc.mem[address('FLAGWRD3')] |= 0o10000; // REFSMFLG, bit 13
  agc.mem[address('FLAGWRD8')] |= 0o6000; // CMOONFLG bit 12, LMOONFLG bit 11

  lm.position = [...state.lmPosition];
  lm.velocity = [...state.lmVelocity];
  lm.site = [...state.site];
  lm.surfaceRadius = Math.hypot(...state.site);
  lm.ephemerisTime = SETUP_TIME + ephemerisOffset();
  lm.orbiting = true;
}
