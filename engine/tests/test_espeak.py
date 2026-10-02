"""espeak-ng, the native half of Kokoro narration, fails a narration rather
than ending the engine.

kokoro-onnx phonemizes through phonemizer, which initialises espeak-ng with
no options. Without espeakINITIALIZE_DONT_EXIT, espeak-ng calls exit(1) when
it cannot load its data, and that ends every job, every connection and the
queue with it. A restart requeues the narration that was rendering, so the
next start ends the same way.

Anything here that can reach that exit runs in a child process, so this one
survives to read how the child ended.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

import espeakng_loader
import pytest
from conftest import make_spec

# The files English narration reads from espeak-ng's data, and no others:
# the phoneme tables, the English dictionary, and the two voices
# `language_of` can ask for. A copy of these phonemizes exactly as the full
# 19 MB directory does, and its deepest file is 15 bytes below the data
# directory, which keeps a copy at 231 bytes inside Windows' 260-character
# MAX_PATH.
_ENGLISH_DATA = (
    "phontab",
    "phonindex",
    "phondata",
    "intonations",
    "en_dict",
    "lang/gmw/en-US",
    "lang/gmw/en",
)

# Over the limit on every platform (160 bytes on Linux and macOS, 231 on
# Windows), and short enough that the copy under it still fits in MAX_PATH.
_TOO_LONG = 240

# Narrates one line through KokoroBackend.execute in a fresh interpreter,
# with espeak-ng's data at argv[1], as many times as argv[4] says, and prints
# how each one ended.
#
# Only the inference session is left out: kokoro_onnx.Kokoro is replaced by a
# class that builds kokoro-onnx's own Tokenizer and phonemizes the way
# Kokoro.create does, so espeak-ng is reached through phonemizer by the same
# route a narration takes, without the 325 MB model CI does not have.
_NARRATE = textwrap.dedent(
    """
    import asyncio
    import sys
    from pathlib import Path

    import espeakng_loader
    import numpy as np

    data, models, out = (Path(arg) for arg in sys.argv[1:4])
    times = int(sys.argv[4])

    # Where espeak-ng's data is for an engine installed under a deeper folder.
    espeakng_loader.get_data_path = lambda: str(data)

    import kokoro_onnx
    from kokoro_onnx.tokenizer import Tokenizer


    class PhonemizeOnly:
        def __init__(self, model_path, voices_path, espeak_config=None, vocab_config=None):
            self.tokenizer = Tokenizer(espeak_config)

        def create(self, text, voice, speed=1.0, lang="en-us"):
            print("phonemes:", self.tokenizer.phonemize(text, lang), flush=True)
            return np.zeros(2400, dtype=np.float32), 24000


    kokoro_onnx.Kokoro = PhonemizeOnly

    from localcut_engine.backends.base import ExecutionContext, GenerationError
    from localcut_engine.backends.kokoro import KokoroBackend
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.graph.model import NodeKind

    backend = KokoroBackend(models_dir=models)
    backend.model_path.parent.mkdir(parents=True, exist_ok=True)
    backend.model_path.touch()
    with open(backend.voices_path, "wb") as pack:
        np.savez(pack, af_sarah=np.zeros(1, dtype=np.float32))

    spec = JobSpec(
        node_id="s1.narration",
        kind=NodeKind.NARRATION,
        output_hash="a" * 64,
        params={"text": "The last of the light passed over the water.", "voice_id": "af_sarah"},
        model=None,
        seed=0,
        input_hashes={},
    )
    for _ in range(times):
        try:
            asyncio.run(backend.execute(spec, ExecutionContext(output_dir=out)))
        except Exception as exc:
            print(f"outcome: {type(exc).__name__}: {exc}", flush=True)
        else:
            print("outcome: narrated", flush=True)
    """
)


def _encoded(path: Path) -> bytes:
    """A path as phonemizer hands it to espeak-ng."""
    return str(path).encode("utf-8")


def _copy_english_data(data: Path) -> Path:
    source = Path(espeakng_loader.get_data_path())
    for name in _ENGLISH_DATA:
        (data / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, data / name)
    return data


def _english_data_at(base: Path, length: int) -> Path:
    """A copy of English's data at a path exactly `length` bytes long, as
    espeak-ng receives it.

    Measured on the resolved path, because that is what phonemizer passes:
    resolving turns macOS's /var into /private/var and a Windows 8.3 name
    into the long one, and either would move the boundary under the test.
    """
    base = base.resolve()
    room = length - len(_encoded(base / "espeak-ng-data"))
    assert room >= 2, f"{base} leaves no room for a {length}-byte data path"
    parts = []
    while room:
        # Each folder costs its name and one separator. A single byte left
        # over could not be filled, so the folder before it gives one up.
        take = min(100, room - 1)
        if room - (take + 1) == 1:
            take -= 1
        parts.append("d" * take)
        room -= take + 1
    data = _copy_english_data(base.joinpath(*parts, "espeak-ng-data"))
    assert len(_encoded(data.resolve())) == length
    return data


def _narrate(data: Path, tmp_path: Path, times: int = 1) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-c",
            _NARRATE,
            str(data),
            str(tmp_path / "models"),
            str(tmp_path / "out"),
            str(times),
        ],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        # The child prints paths, and a Windows pipe is in the ANSI code page.
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        timeout=300,
    )


def _outcomes(run: subprocess.CompletedProcess[str]) -> list[str]:
    """How each narration in the child ended, after checking that the child
    lived to say."""
    output = f"stdout:\n{run.stdout}\nstderr:\n{run.stderr}"
    assert run.returncode == 0, f"the narration ended the process ({run.returncode})\n{output}"
    return [
        line.removeprefix("outcome: ")
        for line in run.stdout.splitlines()
        if line.startswith("outcome: ")
    ]


def _failures(run: subprocess.CompletedProcess[str]) -> list[str]:
    """The message of each narration in the child, every one of which has
    to have failed with a GenerationError."""
    outcomes = _outcomes(run)
    assert outcomes, f"the child reported nothing\n{run.stdout}\n{run.stderr}"
    for outcome in outcomes:
        assert outcome.startswith("GenerationError: "), f"{outcome}\n{run.stderr}"
    return [outcome.removeprefix("GenerationError: ") for outcome in outcomes]


def _ansi_code_page() -> int | None:
    if sys.platform != "win32":
        return None
    import ctypes

    return ctypes.windll.kernel32.GetACP()


@pytest.fixture
def openable(tmp_path):
    """A folder whose path espeak-ng can open here, for checks that are about
    something other than the code page.

    CI's tmp_path is under a folder named "Zoë O'Brien 中文", and on Windows a
    Python without a UTF-8 code page hands espeak-ng that path in the ANSI
    code page, where it names nothing. On Linux and macOS a path is bytes and
    any name opens.
    """
    readable = sys.platform != "win32" or _ansi_code_page() == 65001
    if readable or str(tmp_path.resolve()).isascii():
        yield tmp_path
        return
    folder = Path(tempfile.mkdtemp(prefix="lc-espeak-")).resolve()
    try:
        if not str(folder).isascii():
            pytest.skip(f"no folder espeak-ng can open in code page {_ansi_code_page()}")
        yield folder
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_espeak_ng_that_cannot_start_fails_the_narration_and_not_the_engine(tmp_path):
    """The engine installed in a folder deep enough that espeak-ng's data
    path no longer fits the buffer espeak-ng keeps it in.

    Each narration has to come back as a GenerationError that says so, with
    the numbers someone needs to fix it, the next one in the same process
    too, and nothing may be published: a silent or garbled wav under the
    node's hash would be served as finished narration from then on.
    """
    data = _english_data_at(tmp_path, _TOO_LONG)

    messages = _failures(_narrate(data, tmp_path, times=2))

    from localcut_engine.backends import espeak

    assert len(messages) == 2
    for message in messages:
        assert f"{_TOO_LONG} bytes" in message, message
        assert f"{espeak.DATA_PATH_LIMIT} bytes" in message, message
        assert str(data) in message, message
    out = tmp_path / "out"
    assert not (out.exists() and any(out.iterdir())), "a failed narration left audio behind"


@pytest.mark.parametrize("over", [-1, 0], ids=["one byte short of the limit", "at the limit"])
def test_the_path_limit_is_the_one_this_espeak_ng_was_built_with(openable, over):
    """DATA_PATH_LIMIT restates N_PATH_HOME from espeak-ng's speech.h, a
    number compiled into the library espeakng-loader ships and written down
    again in Python. Nothing reconciles the two but this: one byte under it
    narrates, and a path of exactly that length does not.

    `too_long`, which judges a path without starting espeak-ng, is held to
    what the library did with it.
    """
    from localcut_engine.backends import espeak

    length = espeak.DATA_PATH_LIMIT + over
    data = _english_data_at(openable, length)

    run = _narrate(data, openable)

    assert espeak.too_long(data.resolve()) is (over >= 0)
    if over < 0:
        assert _outcomes(run) == ["narrated"], run.stderr
        # Phonemes, not an empty string: espeak-ng read the copy.
        assert "lˈaɪt" in run.stdout, run.stdout
    else:
        (message,) = _failures(run)
        assert f"{length} bytes" in message, message


def test_data_espeak_ng_cannot_load_is_reported_without_a_guessed_cause(openable):
    """A short path that espeak-ng can open but holds no data. Neither cause
    the message knows applies, so it names neither and points at espeak-ng's
    own words in the engine log."""
    data = openable / "espeak-ng-data"
    data.mkdir()

    (message,) = _failures(_narrate(data, openable))

    assert "engine log" in message, message
    assert "bytes" not in message and "code page" not in message, message


@pytest.mark.skipif(
    sys.platform != "win32" or _ansi_code_page() == 65001,
    reason="only a Windows process whose ANSI code page is not UTF-8 misreads the path",
)
def test_a_path_windows_hands_espeak_ng_in_another_code_page_is_named(openable):
    """espeak-ng opens its data with the narrow Windows APIs, which read
    phonemizer's UTF-8 bytes in the process's ANSI code page. The installed
    engine declares UTF-8 (localcut.spec), which Windows honours from 10
    1903; this interpreter does not, so it misreads a name outside ASCII the
    way an older Windows does.

    Twice in one process, because the second goes differently. The first
    start sets LC_CTYPE to UTF-8 in the C runtime Python shares, so the
    second opens the data, then finds no voices under the misread path and
    fails inside phonemizer. Both have to give the same reason."""
    data = _copy_english_data(openable / "Zoë 中文" / "espeak-ng-data")

    messages = _failures(_narrate(data, openable, times=2))

    assert len(messages) == 2
    for message in messages:
        assert f"code page {_ansi_code_page()}" in message, message
        assert "bytes" not in message, message


def test_phonemizer_initialises_espeak_ng_through_the_guard():
    """The guard rides on how phonemizer's EspeakAPI loads and initialises
    its copy of the library: it assigns the copy to `self._library` and then
    calls `espeak_Initialize` on it. If an upgrade moves that call, this
    fails, rather than the engine ending at the next narration whose data
    espeak-ng cannot load.

    In-process because the data is the installed, loadable copy.
    """
    from kokoro_onnx.tokenizer import Tokenizer
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    from localcut_engine.backends import espeak

    espeak.never_exit()
    # Points phonemizer at the engine's espeak-ng, as Kokoro() does.
    Tokenizer()
    wrapper = EspeakWrapper()

    initialise = wrapper._espeak._library.espeak_Initialize
    assert getattr(initialise, "__wrapped__", None) is not None, (
        "phonemizer initialised espeak-ng without going through the guard"
    )
    # And the path the readiness report measures is the one phonemizer hands
    # espeak-ng.
    assert espeak.data_path() == wrapper.data_path


async def test_a_failure_inside_phonemizer_gets_the_reason_the_path_shows(openable, monkeypatch):
    """espeak-ng can also start and fail later, which phonemizer raises as a
    RuntimeError of its own. A second start under a path Windows misreads
    does that ("language "en-us" is not supported by the espeak backend").
    Where the path shows why, the narration gives that reason instead, and
    where it shows nothing the error is left as it is."""
    from localcut_engine.backends import espeak
    from localcut_engine.backends.base import ExecutionContext, GenerationError
    from localcut_engine.backends.kokoro import KokoroBackend
    from localcut_engine.graph.model import NodeKind

    class NoVoices:
        def create(self, text, voice, speed, lang):
            raise RuntimeError(f'language "{lang}" is not supported by the espeak backend')

    backend = KokoroBackend(models_dir=openable)
    monkeypatch.setattr(backend, "_load", NoVoices)
    spec = make_spec(NodeKind.NARRATION, {"text": "hello", "voice_id": "af_sarah"})
    ctx = ExecutionContext(output_dir=openable / "out")

    deep = openable.resolve() / ("d" * espeak.DATA_PATH_LIMIT) / "espeak-ng-data"
    monkeypatch.setattr(espeakng_loader, "get_data_path", lambda: str(deep))
    with pytest.raises(GenerationError, match=f"{len(espeak.encoded(deep))} bytes"):
        await backend.execute(spec, ctx)

    shallow = openable.resolve() / "espeak-ng-data"
    monkeypatch.setattr(espeakng_loader, "get_data_path", lambda: str(shallow))
    with pytest.raises(RuntimeError, match="not supported by the espeak backend") as raised:
        await backend.execute(spec, ctx)
    assert not isinstance(raised.value, GenerationError)
