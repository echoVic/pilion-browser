/// <reference types="vite/client" />
import type {PilionApi} from '../preload/index.js';
declare global { interface Window {pilion:PilionApi} }
export {};
