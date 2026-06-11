export const BLOCK_CREATION_GUIDE_EVENT = "scheduler:block-creation-guide";

export function emitBlockCreationGuide(blockIds: string[]) {
  if (blockIds.length === 0) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<{ blockIds: string[] }>(BLOCK_CREATION_GUIDE_EVENT, {
      detail: { blockIds },
    }),
  );
}
