import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const writeQueues = new Map<string, Promise<void>>();

function queueKey(dataDir: string, fileName: string): string {
  return `${dataDir}\0${fileName}`;
}

export async function withSerializedJsonWrite<T>(
  dataDir: string,
  fileName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = queueKey(dataDir, fileName);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous.catch(() => undefined).then(() => gate);
  writeQueues.set(key, queued);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (writeQueues.get(key) === queued) {
      writeQueues.delete(key);
    }
  }
}

export async function writeAtomicJsonFileContents(
  dataDir: string,
  fileName: string,
  data: unknown,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, fileName);
  const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmpPath, target);
}

export async function writeAtomicJsonFile(
  dataDir: string,
  fileName: string,
  data: unknown,
): Promise<void> {
  await withSerializedJsonWrite(dataDir, fileName, () =>
    writeAtomicJsonFileContents(dataDir, fileName, data),
  );
}
