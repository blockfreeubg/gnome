/** The engine-host entry (`engine/index.html`): lane b's transport manager and SW client, and the content blocker (Wave B step 3), into the core. */
import { createBlocker } from '../extensions/host/blocker';
import { startEngineHost } from './core';
import { createSwClient } from './sw-client';
import { createTransportManager } from './transport';

startEngineHost({ createTransportManager, createSwClient, createBlocker });
