# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

LocalCut AI has applied to the SignPath Foundation program and is waiting for an answer. Until it is accepted, the installers on the [Releases page](https://github.com/echem-labs/local-cut-ai/releases) are unsigned. The [Download section](../README.md#download) of the README says how to get past the warnings that causes.

## What gets signed

The Windows installer and the LocalCut executables it installs. They are built from a tagged commit by [package.yml](../.github/workflows/package.yml) on GitHub-hosted runners. SignPath checks that a file came from that workflow before it signs it. The certificate is issued to SignPath Foundation, so Windows shows SignPath Foundation as the publisher.

Files from other open source projects that ship inside the installer are not signed with this certificate. The `THIRD-PARTY-NOTICES.txt` in every installer lists them with their licences.

The Linux AppImage and deb are not signed this way. The macOS build is unsigned too, because macOS accepts only Apple's own certificates.

## Team roles

- Committers and reviewers: [Hanzla Mateen](https://github.com/hanzlamateen)
- Approvers: [Hanzla Mateen](https://github.com/hanzlamateen)

A change from anyone outside the team reaches `main` only through a pull request that a reviewer has read. Every signing request is approved by hand in SignPath before anything is signed.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

The [Privacy section](../README.md#privacy) of the README lists every service LocalCut AI contacts when you ask it to: Hugging Face and GitHub for models, each program's own releases, PyPI and PyTorch's package index for ComfyUI on Linux, Ollama's registry for the script model and any cloud provider you add a key for. Each of those services has its own privacy policy.
