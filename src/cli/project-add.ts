import {
  createInterface,
} from "node:readline/promises";

import {
  stdin as input,
  stdout as output,
} from "node:process";

import {
  ProjectRegistryStore,
} from "../projects/project-registry";

const rl = createInterface({
  input,
  output,
});

const registry =
  new ProjectRegistryStore(
    process.cwd(),
  );

try {
  console.log("");
  console.log(
    "========================================",
  );
  console.log(
    " REGISTER PROJECT",
  );
  console.log(
    "========================================",
  );
  console.log("");

  const name =
    await rl.question(
      "Project name: ",
    );

  const suggestedId = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      "",
    )
    .replace(
      /[^a-z0-9]+/g,
      "-",
    )
    .replace(
      /^-+|-+$/g,
      "",
    );

  const enteredId =
    await rl.question(
      `Project ID [${suggestedId}]: `,
    );

  const id =
    enteredId.trim() ||
    suggestedId;

  const root =
    await rl.question(
      "Project path: ",
    );

  const project =
    await registry.addProject({
      id,
      name,
      root,
    });

  console.log("");
  console.log(
    "✓ Project registered",
  );

  console.log(
    `  ID   : ${project.id}`,
  );

  console.log(
    `  Name : ${project.name}`,
  );

  console.log(
    `  Root : ${project.topology.workspaceRoot}`,
  );

  console.log("");
} catch (error) {
  console.error("");
  console.error(
    "✗ Could not register project.",
  );

  console.error(
    error instanceof Error
      ? error.message
      : error,
  );

  process.exitCode = 1;
} finally {
  rl.close();
}
