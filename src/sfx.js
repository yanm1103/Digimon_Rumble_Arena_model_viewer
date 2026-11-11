// The game's menu sounds (public/sfx, cut by tools/export_sfx.py from the sound bank sys_se), played with Web Audio. Browsers only let
// a page make sound after the visitor has done something with it, so the audio context is made on the first play() (always called from
// a click or a key) and the files are loaded then. The same sound can't start again within MIN_GAP seconds (a held key, a dragged slider).
const NAMES = ["cursor", "confirm", "back", "step", "pause", "code"];
const MIN_GAP = 0.06;
const VOLUME = 0.6; // the gain at the slider's full volume: the game plays them at 80 of 127

export function createSfx(base, on = true, volume = 1) {
  let ctx = null;
  let master = null;
  let buffers = null; // name -> Promise<AudioBuffer>
  const last = {};

  function start() {
    if (ctx) return;
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) return;
    ctx = new Context();
    master = ctx.createGain();
    master.gain.value = VOLUME * volume;
    master.connect(ctx.destination);
    buffers = Object.fromEntries(
      NAMES.map((name) => [
        name,
        fetch(`${base}sfx/${name}.wav`)
          .then((r) => r.arrayBuffer())
          .then((data) => ctx.decodeAudioData(data))
          .catch(() => null),
      ]),
    );
  }

  async function play(name) {
    if (!on) return;
    // nothing before the visitor's first click or key: the page isn't allowed to make sound, and it would come out late
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    start();
    if (!ctx || !buffers[name]) return;
    const now = ctx.currentTime;
    if (now - (last[name] ?? -1) < MIN_GAP) return;
    last[name] = now;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const buffer = await buffers[name];
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    source.start();
  }

  return {
    play,
    get on() {
      return on;
    },
    set on(value) {
      on = !!value;
    },
    // 0 to 1
    get volume() {
      return volume;
    },
    set volume(value) {
      volume = Math.max(0, Math.min(1, value));
      if (master) master.gain.value = VOLUME * volume;
    },
  };
}
