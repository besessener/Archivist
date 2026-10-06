import type { Services } from '../create-services';
import type { HandlerGroup } from './types';

export function speechHandlers({ speech }: Services): HandlerGroup<'speech'> {
  return {
    'speech:status': () => speech.status(),
    'speech:install': () => speech.install(),
    'speech:cancelInstall': () => speech.cancelInstall(),
    'speech:remove': ({ model }) => speech.remove(model),
    'speech:transcribe': ({ audio }) => speech.transcribe(audio),
  };
}
