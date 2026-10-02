"""The typeface the engine draws text with, carried inside the package.

FFmpeg looks a font up through the system unless a filter is handed one. On
a machine with no fonts installed, which is what the engine's container image
is and what a fresh Windows box running a downloaded FFmpeg can be, that
lookup finds nothing, and libass burns text that is blank while ffmpeg exits
0. So titles and captions are drawn from these files, never from whatever the
system happens to have. libass still asks the system, through whichever font
provider the ffmpeg build has, for a character these faces lack: a CJK title
or caption draws from a system font when that provider finds one.

Inter, the desktop's UI typeface, under the SIL Open Font License 1.1, whose
text is `assets/fonts/LICENSE.txt`. The faces are the static ones from the
release, unmodified. Not the variable font: libass does not pick a variable
font's named Bold instance, it emboldens the default Regular outline, so a
bold caption would be a synthetic one.
"""

from __future__ import annotations

from pathlib import Path

#: The family both faces declare, which is the name an ASS style asks for.
FAMILY = "Inter"
#: The rsms/inter release the faces were taken from.
VERSION = "4.1"
SOURCE = f"https://github.com/rsms/inter/releases/tag/v{VERSION}"

#: The faces and nothing else. libass loads every file in the directory it is
#: pointed at as a font and logs an error for each one that is not, which is
#: why the licence sits one level up.
DIR = Path(__file__).resolve().parent / "assets" / "fonts" / "ttf"
#: On-screen titles, whose style is not bold.
REGULAR = "Inter-Regular.ttf"
#: Captions, whose style is bold.
BOLD = "Inter-Bold.ttf"
LICENSE = DIR.parent / "LICENSE.txt"

#: Regular's vertical metrics in font units, from its head and OS/2 tables. A
#: title's size is an em, libass sizes a font by WIN_ASCENT + WIN_DESCENT, and
#: a top-aligned line's ascent sits WIN_ASCENT - CAP_HEIGHT above its capitals
#: (captions.title_to_ass).
UNITS_PER_EM = 2048
WIN_ASCENT = 1984
WIN_DESCENT = 494
CAP_HEIGHT = 1490
