// Pi's tool environment in the coder (B-40/TEAM-02, P0.8): Pi's grep tool
// asks the SDK's tools manager for ripgrep, which looks in its own bin
// directory first — <PI_CODING_AGENT_DIR or $HOME/.pi/agent>/bin, fixed when
// the SDK module loads — then on PATH, and without either downloads the
// latest release into that directory unless PI_OFFLINE is set. The
// candidate's HOME is its own writable workspace tree, so that bin directory
// would be candidate-writable and a download an unpinned network fetch.
// Importing this module pins, before any Pi module is loaded, the
// offline mode and the image's root-owned agent directory
// (/opt/pi-agent, its bin/rg the image's pinned ripgrep): the supervisor
// gives the candidate a fixed environment (PATH, HOME and the round's
// paths only), so the coder pins these itself. Entrypoints import it
// first (coder.ts); the Pi modules of this package import it too.

/** The image's root-owned Pi agent directory (Dockerfile): bin/rg is the pinned ripgrep. */
export const piAgentDir = "/opt/pi-agent";

process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = piAgentDir;
