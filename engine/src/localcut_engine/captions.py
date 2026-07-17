"""Caption assembly — pure functions between forced alignment and export.

Word timestamps (from the align backend) become short readable cues; cues
serialize to SRT (the caption node's artifact and the sidecar format) and to
styled ASS for burn-in. Short-form pacing: few words per cue, bottom-third,
strong outline.
"""

from __future__ import annotations

from dataclasses import dataclass

MAX_CUE_WORDS = 5
MAX_CUE_SPAN_S = 2.4
CUE_GAP_BREAK_S = 0.6  # a pause this long starts a new cue
_SENTENCE_ENDS = (".", "!", "?", ",", ";", ":")


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
        if word.text.strip().endswith(_SENTENCE_ENDS):
            flush()
    flush()
    return cues


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
