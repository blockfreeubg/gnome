/**
 * Stand-in for the engine-host entry until frontend/engine/index.html exists (WAVE-B §3): the build test builds it
 * as the second Vite input next to the real app and checks that neither page's import graph reaches the other's
 * code. It imports what the engine host may import (src/shared/**, src/lib/keys.ts) statically and dynamically.
 */
import { PROTOCOL_VERSION, validateCommandMessage } from '../../../../../frontend/src/shared/engine-protocol';
import { engineHostUrl } from '../../../../../frontend/src/shared/proxy-origin';
import { parseCombo } from '../../../../../frontend/src/lib/keys';

const late = (): Promise<typeof import('../../../../../frontend/src/shared/transport')> => import('../../../../../frontend/src/shared/transport');

document.title = `fixture ${PROTOCOL_VERSION} ${engineHostUrl(location.origin)} ${parseCombo('Mod+K') !== null} ${validateCommandMessage(null).ok}`;
void late().then((t) => t.backoffDelayMs(1, 0.5));
