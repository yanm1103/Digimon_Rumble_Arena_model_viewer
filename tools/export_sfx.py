#!/usr/bin/env python3

"""Cuts the game's menu sounds out of its sound bank (US) as small mono WAVs.



  python tools/export_sfx.py <sys_se> [--out public]



<sys_se> is the path of the bank without extension (sys_se.vh is its header and sys_se.vb its sound data, both in the decompilation's
assets/us/sound). writes

  public/sfx/<name>.wav       one file per menu sound (SOUND_MENU_* in include/engine/sound/sound_control.h, sound effects 0x0F..0x15 of
                              digimon.sdf, each tone 0 of one program of the bank): cursor, confirm, back, step, pause, code. The refuse
                              sound (0x12) is not cut: nothing in the viewer is ever refused

A VAB is a 32 byte header, 128 program entries of 16 bytes, 16 tone entries of 32 bytes for each program that has tones, 256 sizes of the
sounds (in 8 byte units; entry n is sound n, entry 0 is not used) and, in the .vb, the sounds one after the other as SPU ADPCM (16 byte
blocks: shift and filter, flags, 28 samples in 14 bytes). The effect plays tone 0 of its program at note 60: the speed is
44100 Hz * 2^((60 - center + shift / 128) / 12), which is about 16 kHz for the cursor, confirm, back and step sounds and 7.1 kHz for
pause and code.
"""
import argparse
import os
import struct
import sys
import wave

# SOUND_MENU_*: name -> program of sys_se
SOUNDS = {"cursor": 0, "confirm": 1, "back": 2, "step": 6, "pause": 7, "code": 9}
NOTE = 60
FILTERS = [(0, 0), (60, 0), (115, -52), (98, -55), (122, -60)]


def decode_adpcm(data):
    out = []
    s1 = s2 = 0
    for i in range(0, len(data) - 15, 16):
        shift = min(data[i] & 15, 12)
        k1, k2 = FILTERS[min(data[i] >> 4, 4)]
        if data[i + 1] == 7:  # end of the sound
            break
        for j in range(14):
            for nib in (data[i + 2 + j] & 15, data[i + 2 + j] >> 4):
                v = nib - 16 if nib >= 8 else nib
                s = (v << (12 - shift)) + ((s1 * k1) >> 6) + ((s2 * k2) >> 6)
                s = max(-32768, min(32767, s))
                out.append(s)
                s2, s1 = s1, s
    return out


def read_vab(base):
    vh = open(base + ".vh", "rb").read()
    vb = open(base + ".vb", "rb").read()
    if vh[:4] != b"pBAV":
        sys.exit("%s.vh is not a VAB header" % base)
    programs, _tones, vags = struct.unpack_from("<HHH", vh, 0x12)
    tone_at = 0x20 + 128 * 16
    tones = {}
    n = 0
    for p in range(128):
        if vh[0x20 + p * 16] > 0:  # this program has tones
            o = tone_at + n * 16 * 32
            center, shift = vh[o + 4], vh[o + 5]
            vag = struct.unpack_from("<h", vh, o + 22)[0]  # tone 0's sound number
            tones[p] = (center, shift, vag)
            n += 1
    sizes = struct.unpack_from("<256H", vh, tone_at + n * 16 * 32)
    sounds, pos = [], 0
    for i in range(1, vags + 1):
        sounds.append(vb[pos : pos + sizes[i] * 8])
        pos += sizes[i] * 8
    return tones, sounds


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sys_se", help="sys_se bank without extension")
    ap.add_argument("--out", default="public")
    a = ap.parse_args()
    tones, sounds = read_vab(a.sys_se)
    out_dir = os.path.join(a.out, "sfx")
    os.makedirs(out_dir, exist_ok=True)
    for name, prog in SOUNDS.items():
        center, shift, vag = tones[prog]
        pcm = decode_adpcm(sounds[vag - 1])
        rate = round(44100 * 2 ** ((NOTE - center + shift / 128) / 12))
        path = os.path.join(out_dir, name + ".wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(struct.pack("<%dh" % len(pcm), *pcm))
        print("%-8s program %d, sound %d: %d samples at %d Hz (%.2f s)" % (name, prog, vag, len(pcm), rate, len(pcm) / rate))


if __name__ == "__main__":
    main()
