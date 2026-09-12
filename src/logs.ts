import { stripVTControlCharacters } from "node:util";

export type LogEntry = { id: number; source: string; message: string };

/** A separate decoder for each stream keeps stderr and interleaved services independent. */
export function logStream(emit: (message: string) => void) {
  let line = "";
  let carriage = false;
  let lastProgress = "";
  const flush = (progress: boolean) => {
    const message = stripVTControlCharacters(line).trimEnd();
    const normalized = message.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/, "");
    if (message && normalized !== lastProgress) emit(message);
    lastProgress = progress ? normalized : "";
    line = "";
  };
  return {
    write(chunk: string) {
      for (const char of chunk) {
        if (carriage) {
          flush(char !== "\n");
          carriage = false;
          if (char === "\n") continue;
        }
        if (char === "\r") carriage = true;
        else if (char === "\n") flush(false);
        else line += char;
      }
    },
    end() {
      flush(carriage);
      carriage = false;
    },
  };
}
