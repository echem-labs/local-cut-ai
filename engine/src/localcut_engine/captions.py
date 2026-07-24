"""Caption assembly — pure functions between forced alignment and export.

Word timestamps (from the align backend) become short readable cues; cues
serialize to SRT (the caption node's artifact and the sidecar format) and to
styled ASS for burn-in. Short-form pacing: few words per cue, bottom-third,
strong outline.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

MAX_CUE_WORDS = 5
MAX_CUE_SPAN_S = 2.4
CUE_GAP_BREAK_S = 0.6  # a pause this long starts a new cue
_STRONG_ENDS = (".", "!", "?")
_WEAK_ENDS = (",", ";", ":")
# A comma only earns a cue break once the cue carries enough words: script
# punctuation (restored by anchoring) is far denser than what transcription
# emits, and breaking on every comma leaves single words flashing on screen.
MIN_WEAK_BREAK_WORDS = 3
MIN_CUE_S = 0.4  # a shorter cue reads as a flash; zero-length never renders


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Cue:
    start: float
    end: float
    text: str


def _norm(token: str) -> str:
    return re.sub(r"[^a-z0-9']+", "", token.lower())


def _match_keys(tokens: list[str], side: str) -> list[str]:
    """Comparison keys for the aligner. A token that normalizes to nothing —
    standalone punctuation, or any non-Latin script — gets a position-unique
    key so it can never match another empty by accident; it falls into a
    replace/insert span instead, where the script text still wins."""
    return [_norm(token) or f"\x00{side}{index}" for index, token in enumerate(tokens)]


def anchor_words_to_text(words: list[Word], text: str) -> list[Word]:
    """Replace ASR word text with the narration's ground-truth tokens,
    keeping the ASR timings. Free transcription mishears homophones
    ("sun" → "son") and drops the script's punctuation/casing — but the
    narration audio was synthesized FROM the script, so the script is the
    truth and the audio only contributes timing."""
    truth = text.split()
    if not truth or not words:
        return words
    matcher = difflib.SequenceMatcher(
        a=_match_keys([w.text for w in words], "a"),
        b=_match_keys(truth, "b"),
        autojunk=False,
    )
    out: list[Word] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                out.append(Word(text=truth[j1 + k], start=words[i1 + k].start, end=words[i1 + k].end))
        elif tag == "replace":
            # Misheard span: spread the true tokens over its time window.
            start, end = words[i1].start, words[i2 - 1].end
            if end <= start:
                # ASR occasionally emits zero-width words. Borrow time up to
                # the next transcribed word, never past it.
                nominal = start + 0.15 * (j2 - j1)
                end = min(nominal, words[i2].start) if i2 < len(words) else nominal
            step = max(0.0, end - start) / (j2 - j1)
            for k in range(j2 - j1):
                out.append(
                    Word(text=truth[j1 + k], start=start + k * step, end=start + (k + 1) * step)
                )
        elif tag == "insert":
            # Words the ASR never emitted: lay them into the gap BEFORE the
            # next transcribed word, never past it — time invented beyond a
            # real boundary would overlap the next cue (or, at a scene's
            # tail, the next scene's captions). A span with no room collapses
            # to zero width here; words_to_cues gives the cue display time.
            n = j2 - j1
            anchor = out[-1].end if out else words[0].start
            following = words[i1].start if i1 < len(words) else anchor
            step = max(0.0, following - anchor) / n
            for k in range(n):
                out.append(
                    Word(text=truth[j1 + k], start=anchor + k * step, end=anchor + (k + 1) * step)
                )
        # "delete": the ASR hallucinated a word the script doesn't have — drop it.
    return out


def words_to_cues(words: list[Word]) -> list[Cue]:
    """Group word timestamps into short cues, breaking on pauses,
    punctuation, word count and span."""
    cues: list[Cue] = []
    current: list[Word] = []

    def flush() -> None:
        if current:
            text = " ".join(w.text.strip() for w in current).strip()
            if text:
                cues.append(Cue(start=current[0].start, end=current[-1].end, text=text))
            current.clear()

    for word in words:
        if current:
            span = word.end - current[0].start
            gap = word.start - current[-1].end
            if len(current) >= MAX_CUE_WORDS or span > MAX_CUE_SPAN_S or gap > CUE_GAP_BREAK_S:
                flush()
        current.append(word)
        token = word.text.strip()
        if token.endswith(_STRONG_ENDS) or (
            token.endswith(_WEAK_ENDS) and len(current) >= MIN_WEAK_BREAK_WORDS
        ):
            flush()
    flush()
    return _give_display_time(cues)


def _give_display_time(cues: list[Cue]) -> list[Cue]:
    """A cue with no measurable span never renders — SRT consumers drop it
    and burn-in flashes nothing. Stretch a too-short cue toward MIN_CUE_S,
    but never into the cue that follows: overlapping captions would stack
    two lines on screen.

    Words the aligner could not place in time at all (script words the ASR
    skipped between two adjacent words) arrive here as a zero-span cue with
    no room to grow. Rather than invent time that would overlap, fold their
    text into the next cue — the words still reach the screen, beside the
    ones they were spoken with."""
    out: list[Cue] = []
    carried = ""
    for index, cue in enumerate(cues):
        if carried:
            cue.text = f"{carried} {cue.text}"
            carried = ""
        if cue.end - cue.start < MIN_CUE_S:
            ceiling = cues[index + 1].start if index + 1 < len(cues) else cue.start + MIN_CUE_S
            if ceiling <= cue.start:
                carried = cue.text
                continue
            cue.end = max(cue.end, min(cue.start + MIN_CUE_S, ceiling))
        out.append(cue)
    if carried and out:  # nothing followed it — append to the last cue shown
        out[-1].text = f"{out[-1].text} {carried}"
    return out


def _srt_time(seconds: float) -> str:
    ms = max(0, round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def cues_to_srt(cues: list[Cue]) -> str:
    blocks = [
        f"{i + 1}\n{_srt_time(c.start)} --> {_srt_time(c.end)}\n{c.text}\n"
        for i, c in enumerate(cues)
    ]
    return "\n".join(blocks)


def parse_srt(text: str) -> list[Cue]:
    cues: list[Cue] = []
    # Normalize CRLF/CR first: canonical SubRip separates cue blocks with
    # "\r\n\r\n", which a bare split("\n\n") never matches — collapsing the
    # whole file into one garbled cue.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for block in text.strip().split("\n\n"):
        lines = [line for line in block.splitlines() if line.strip()]
        timing = next((line for line in lines if "-->" in line), None)
        if timing is None:
            continue
        start_raw, _, end_raw = timing.partition("-->")
        try:
            start, end = _parse_srt_time(start_raw), _parse_srt_time(end_raw)
        except ValueError:
            continue
        body = lines[lines.index(timing) + 1 :]
        if body:
            cues.append(Cue(start=start, end=end, text=" ".join(body)))
    return cues


def _parse_srt_time(raw: str) -> float:
    h, m, s = raw.strip().replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def _ass_time(seconds: float) -> str:
    cs = max(0, round(seconds * 100))
    h, rem = divmod(cs, 360_000)
    m, rem = divmod(rem, 6_000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02}:{s:02}.{cs:02}"


_ASS_HEADER = """\
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Default,Sans,84,&H00FFFFFF,&H00101014,&H80000000,-1,5,1,2,60,60,340

[Events]
Format: Layer, Start, End, Style, Text
"""


def srt_to_ass(srt_text: str) -> str:
    """Sidecar SRT → styled burn-in ASS (bottom-third, bold, outlined)."""
    lines = [
        "Dialogue: 0,{},{},Default,{}".format(
            _ass_time(c.start),
            _ass_time(c.end),
            c.text.replace("\n", r"\N").replace("{", "(").replace("}", ")"),
        )
        for c in parse_srt(srt_text)
    ]
    return _ASS_HEADER + "\n".join(lines) + "\n"
