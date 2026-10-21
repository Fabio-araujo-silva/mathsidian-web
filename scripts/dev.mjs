// npm run dev: sobe o servidor (porta 3000, reinicia ao salvar) e o Vite (porta 5173, com proxy pra /api).
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const procs = [
  spawn(process.execPath, ["--watch", "server/src/index.js"], {
    stdio: "inherit",
    env: { ...process.env, REGISTRATION: process.env.REGISTRATION || "open" },
  }),
  spawn(isWin ? "npm.cmd" : "npm", ["run", "dev", "-w", "web"], { stdio: "inherit", shell: isWin }),
];

const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => code && stop()));
