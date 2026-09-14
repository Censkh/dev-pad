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
    lastProgress = progress ? normalized || lastProgress : "";
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
        else {
          line += char;
          // Spinners also redraw with cursor-to-column-one and erase-line sequences.
          const redraw =
            (char === "G" || char === "K") &&
            ["\x1b[G", "\x1b[0G", "\x1b[1G", "\x1b[2K"].find((sequence) => line.endsWith(sequence));
          if (redraw) {
            line = line.slice(0, -redraw.length);
            flush(true);
          }
        }
      }
    },
    end() {
      flush(carriage);
      carriage = false;
    },
  };
}
