import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Sandbox } from "@ai-hero/sandcastle";

export function createSandboxTools(sandbox: Sandbox) {
  const sandbox_bash = defineTool({
    name: "sandbox_bash",
    label: "Sandbox Bash",
    description: "Execute a bash command inside the Sandcastle Docker container.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      cwd: Type.Optional(Type.String({ description: "Working directory inside the sandbox (defaults to repository root)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      let timeoutHandle: NodeJS.Timeout;
      const timeoutPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        const ms = (params.timeout || 600) * 1000; // default to 10 minutes max per command
        timeoutHandle = setTimeout(() => {
          resolve({ stdout: "", stderr: `Command timed out after ${ms / 1000} seconds.`, exitCode: 124 });
        }, ms);
      });

      let stdoutBuffer = "";
      const execPromise = sandbox.exec(params.command, { 
        cwd: params.cwd,
        onLine: (line) => {
          stdoutBuffer += line + "\n";
          if (onUpdate) {
            onUpdate({ delta: line + "\n" });
          }
        }
      }).finally(() => {
        clearTimeout(timeoutHandle);
      });

      const result = await Promise.race([execPromise, timeoutPromise]);
      let text = result.exitCode === 124 ? stdoutBuffer + "\n" + result.stderr : stdoutBuffer;
      if (result.exitCode !== 124 && result.stderr) text += (text ? "\n" : "") + result.stderr;
      if (result.exitCode !== 0) {
        text += `\n(Command exited with code ${result.exitCode})`;
      }
      return {
        content: [{ type: "text", text: text || "(Command produced no output)" }],
        details: {},
        isError: result.exitCode !== 0,
      };
    },
  });

  const sandbox_read = defineTool({
    name: "sandbox_read",
    label: "Sandbox Read",
    description: "Read a file from inside the Sandcastle Docker container.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read" }),
    }),
    async execute(_id, params) {
      const result = await sandbox.exec(`cat "${params.path}"`);
      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text", text: result.stderr || "Error reading file." }],
          details: {},
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.stdout }],
        details: {},
      };
    },
  });

  const sandbox_write = defineTool({
    name: "sandbox_write",
    label: "Sandbox Write",
    description: "Write content to a file inside the Sandcastle Docker container.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file" }),
      content: Type.String({ description: "Content to write" }),
    }),
    async execute(_id, params) {
      // Use bash here-doc or base64 to avoid quoting issues
      const b64 = Buffer.from(params.content).toString("base64");
      const result = await sandbox.exec(`mkdir -p "$(dirname "${params.path}")" && echo "${b64}" | base64 -d > "${params.path}"`);
      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text", text: result.stderr || "Error writing file." }],
          details: {},
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Successfully wrote to ${params.path}` }],
        details: {},
      };
    },
  });

  const sandbox_edit = defineTool({
    name: "sandbox_edit",
    label: "Sandbox Edit",
    description: "Edit a single file using exact text replacement inside the Sandcastle Docker container.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit" }),
      edits: Type.Array(Type.Object({
        oldText: Type.String({ description: "Exact text to replace" }),
        newText: Type.String({ description: "Replacement text" }),
      })),
    }),
    async execute(_id, params) {
      // Fetch file content
      const readRes = await sandbox.exec(`cat "${params.path}"`);
      if (readRes.exitCode !== 0) {
        return {
          content: [{ type: "text", text: readRes.stderr || "Error reading file for edit." }],
          details: {},
          isError: true,
        };
      }
      let content = readRes.stdout;
      
      for (const edit of params.edits) {
        if (!content.includes(edit.oldText)) {
          return {
            content: [{ type: "text", text: `Could not find exact oldText in ${params.path}` }],
            details: {},
            isError: true,
          };
        }
        content = content.replace(edit.oldText, edit.newText);
      }

      // Write it back
      const b64 = Buffer.from(content).toString("base64");
      const writeRes = await sandbox.exec(`echo "${b64}" | base64 -d > "${params.path}"`);
      if (writeRes.exitCode !== 0) {
        return {
          content: [{ type: "text", text: writeRes.stderr || "Error saving edited file." }],
          details: {},
          isError: true,
        };
      }
      
      return {
        content: [{ type: "text", text: `Successfully applied edits to ${params.path}` }],
        details: {},
      };
    },
  });

  return [sandbox_bash, sandbox_read, sandbox_write, sandbox_edit];
}
