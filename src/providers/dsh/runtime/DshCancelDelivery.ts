export const DSH_CANCEL_DELIVERY_GRACE_MS = 250;

export interface DshFlushableTransport {
  flush(): Promise<void>;
}

export function waitForDshCancelDelivery(
  transport: DshFlushableTransport | null | undefined,
): Promise<void> {
  let delivery: Promise<void>;
  try {
    delivery = transport?.flush() ?? Promise.resolve();
  } catch {
    delivery = Promise.resolve();
  }

  return new Promise(resolve => {
    const timeout = window.setTimeout(resolve, DSH_CANCEL_DELIVERY_GRACE_MS);
    void delivery.then(
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
    );
  });
}
