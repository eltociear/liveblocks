import fs from "fs";
import path from "path";
import crypto from "crypto";
import c from "ansi-colors";
import prompts, { PromptObject } from "prompts";
import {
  clonePrivateRepo,
  cloneRepo,
  initializeGit,
  install as installApp,
  getPackageManager,
  confirmDirectoryEmpty,
  server,
  stageAndCommit,
  loadingSpinner,
} from "../../utils";
import open from "open";
import {
  GeneralIntegrationCallback,
  GeneralIntegrationData,
  VercelIntegrationCallback,
  VercelIntegrationData,
} from "../types";
import {
  auth0AuthProvider,
  demoAuthProvider,
  githubAuthProvider,
} from "./auth-provider-code";
import {
  NEXTJS_STARTER_KIT_AUTH_PROVIDERS,
  NEXTJS_STARTER_KIT_GUIDE_URL,
  NEXTJS_STARTER_KIT_REPO_DIRECTORY,
  NEXTJS_STARTER_KIT_VERCEL_DEPLOYMENT_URL_DEV,
} from "../constants";

type Questions = {
  name: string;
  auth: typeof NEXTJS_STARTER_KIT_AUTH_PROVIDERS[number];
  vercel: boolean;
  liveblocksSecret: boolean;
  git: boolean;
  install: boolean;
  openBrowser: boolean;
};

export async function create(flags: Record<string, any>) {
  const packageManager = flags.packageManager || getPackageManager();

  // === Configure by asking prompts, questions skipped if flags exist ===
  const questions: PromptObject<keyof Questions>[] = [
    {
      type: flags.name ? null : "text",
      name: "name",
      message: "What would you like to name your project directory?",
    },
    {
      type:
        flags.auth && NEXTJS_STARTER_KIT_AUTH_PROVIDERS.includes(flags.auth)
          ? null
          : "select",
      name: "auth",
      message:
        "Which authentication method would you like to use in your project?",
      choices: [
        {
          title: "Demo",
          description: "Add your own authentication later",
          value: "demo",
        },
        {
          title: "GitHub",
          description: "Sign in with GitHub (instructions in guide)",
          value: "github",
        },
        {
          title: "Auth0",
          description: "Sign in with Auth0 (instructions in guide)",
          value: "auth0",
        },
      ],
      initial: false,
      active: "yes",
      inactive: "no",
    },
    {
      // TODO add Vercel flag
      type: "confirm",
      name: "vercel",
      message: "Would you like to deploy on Vercel?",
      initial: true,
      active: "yes",
      inactive: "no",
    },
    {
      // TODO add liveblocksSecret flag
      type: (_, values) => {
        // Vercel integration always uses liveblocksSecret, so skip question
        if (values.vercel) {
          return null;
        }
        // TODO check for liveblocksSecret flag
        return "confirm";
      },
      name: "liveblocksSecret",
      message:
        "Would you like to get your Liveblocks secret key automatically (recommended)?",
      initial: true,
      active: "yes",
      inactive: "no",
    },
    {
      type: (_, values) => {
        // Vercel needs git, so skip question if Vercel is true
        // TODO check for Vercel flag too
        if (values.vercel) {
          return null;
        }
        return flags.git !== undefined ? null : "confirm";
      },
      name: "git",
      message: "Would you like to initialize a new git repository?",
      initial: true,
      active: "yes",
      inactive: "no",
    },
    {
      type: flags.install !== undefined ? null : "confirm",
      name: "install",
      message: `Would you like to install with ${packageManager}?`,
      initial: true,
      active: "yes",
      inactive: "no",
    },
    {
      type: (_, values) => {
        if (values.vercel || values.liveblocksSecret) {
          return "confirm";
        }

        return null;
      },
      name: "openBrowser",
      message: "Open browser window to continue set up?",
      initial: true,
      active: "yes",
      inactive: "no",
    },
  ];

  // === Prompt return values, using flags as defaults ===================
  const {
    name = flags.name,
    auth = flags.auth,
    vercel = flags.vercel,
    liveblocksSecret = flags.liveblocksSecret,
    git = flags.git,
    install = flags.install,
    openBrowser = false,
  }: Questions = await prompts(questions, {
    onCancel: () => {
      console.log(c.redBright.bold("Cancelled"));
      console.log();
      process.exit(0);
    },
  });

  if ((vercel || liveblocksSecret) && !openBrowser) {
    console.log(c.redBright.bold("Cancelled"));
    console.log();
    return;
  }

  const appDir = path.join(process.cwd(), "./" + name);
  let repoDir = NEXTJS_STARTER_KIT_REPO_DIRECTORY;
  let clonedPrivateRepo = false;
  let liveblocksSecretKeyValue = "";
  const nextAuthSecretValue = crypto.randomBytes(32).toString("base64");

  // Empty/create appDir repo
  await confirmDirectoryEmpty(appDir);

  // === Deploy on Vercel and use Vercel integration to get secret key ===
  if (vercel) {
    const vercelSpinner = loadingSpinner("", c.whiteBright("▲")).start(
      c.whiteBright.bold(
        "Opening Vercel, continue deploying then check back..."
      )
    );
    const vercelData: VercelIntegrationCallback = (await server(
      async (origin) => {
        const data: VercelIntegrationData = {
          env: [{ name: "LIVEBLOCKS_SECRET_KEY", type: "secret" }],
          envReady: [{ name: "NEXTAUTH_SECRET", value: nextAuthSecretValue }],
          callbackUrls: [origin],
        };
        const encodedData = Buffer.from(JSON.stringify(data)).toString(
          "base64url"
        );

        // const deployUrl = NEXTJS_STARTER_KIT_VERCEL_DEPLOYMENT_URL(encodedData, name)
        const deployUrl = NEXTJS_STARTER_KIT_VERCEL_DEPLOYMENT_URL_DEV(
          encodedData,
          name
        );

        await open(deployUrl);
      }
    )) as VercelIntegrationCallback;

    if (vercelData?.env?.LIVEBLOCKS_SECRET_KEY) {
      liveblocksSecretKeyValue = vercelData.env.LIVEBLOCKS_SECRET_KEY;
    }

    if (vercelData.repo) {
      vercelSpinner.text = c.whiteBright.bold("Cloning new repo...");
      const privateRepoDir = `https://${vercelData.repo.type}.com/${vercelData.repo.location}`;
      clonedPrivateRepo = await clonePrivateRepo({ privateRepoDir, appDir });
    }
    vercelSpinner.succeed(c.green("Vercel deployment complete"));
  }

  // === Get Liveblocks secret key from general integration ==============
  if (liveblocksSecret) {
    const liveblocksSpinner = loadingSpinner().start(
      c.whiteBright.bold(
        "Opening Liveblocks, import your API key then check back..."
      )
    );

    const liveblocksData = (await server((origin) => {
      const data: GeneralIntegrationData = {
        env: [{ name: "LIVEBLOCKS_SECRET_KEY", type: "secret" }],
        callbackUrls: [origin],
      };
      const encodedData = Buffer.from(JSON.stringify(data)).toString(
        "base64url"
      );
      // TODO env var this
      const liveblocksUrl = `http://localhost:3001/integrations/general?data=${encodedData}`;
      open(liveblocksUrl);
    })) as GeneralIntegrationCallback;

    if (liveblocksData?.env?.LIVEBLOCKS_SECRET_KEY) {
      liveblocksSecretKeyValue = liveblocksData.env.LIVEBLOCKS_SECRET_KEY;
    }

    liveblocksSpinner.succeed(c.green("Liveblocks secret key added"));
  }

  const envVariables = [
    {
      key: "LIVEBLOCKS_SECRET_KEY",
      value: liveblocksSecretKeyValue,
    },
    ...getAuthEnvVariables(auth),
    {
      // https://next-auth.js.org/configuration/options#secret
      key: "NEXTAUTH_SECRET",
      value: nextAuthSecretValue,
    },
  ];

  // === Clone starter kit repo ==========================================
  if (!clonedPrivateRepo) {
    const result = await cloneRepo({ repoDir, appDir });

    if (!result) {
      console.log();
      console.log(c.redBright.bold("Target repo is empty"));
      console.log();
      return;
    }
  }

  const filesToWrite: { location: string; content: string }[] = [];

  // === Set up starter kit authentication ===============================
  const nextauthTsLocation = path.join(
    appDir,
    "pages",
    "api",
    "auth",
    "[...nextauth].ts"
  );
  const nextauthTs = fs.readFileSync(nextauthTsLocation, "utf-8");
  filesToWrite.push({
    location: nextauthTsLocation,
    content: addAuthproviderSetup(auth, nextauthTs),
  });

  // === Add .env.local ==================================================
  filesToWrite.push({
    location: path.join(appDir, ".env.local"),
    content: envVariables.map(({ key, value }) => `${key}=${value}`).join("\n"),
  });

  // === Add package.json ================================================
  const packageJsonLocation = path.join(appDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonLocation, "utf8"));
  filesToWrite.push({
    location: packageJsonLocation,
    content: JSON.stringify(packageJson, null, 2),
  });

  // === Write files, install, set up git ================================
  filesToWrite.forEach(({ location, content }) => {
    fs.writeFileSync(location, content);
  });

  if (install) {
    await installApp({
      appDir,
      packageManager,
    });
  }

  if (git) {
    await initializeGit({ appDir });
  } else if (vercel) {
    await stageAndCommit({ appDir });
  }

  // === Final console messages ==========================================
  const cmd = `${packageManager}${packageManager === "npm" ? " run" : ""}`;
  let instructionCount = 1;

  console.log();
  console.log(c.bold("Start using the Next.js Starter Kit by typing:"));

  console.log(` ${instructionCount++}: ${c.cyanBright(`cd ${name}`)}${
    !install
      ? `
 ${instructionCount++}: ${c.cyanBright(`${packageManager} install`)}`
      : ""
  }
 ${instructionCount++}: ${c.cyanBright(`${cmd} dev`)}`);

  console.log();
  console.log(c.bold.magentaBright("✨ Ready to collaborate!"));

  console.log();
  if (auth && auth !== "demo") {
    console.log(
      c.bold(
        "Read the guide to finish setting up your authentication, and the rest of your app:"
      )
    );
  } else {
    console.log(c.bold("Read the guide to finish setting up your app:"));
  }
  console.log(NEXTJS_STARTER_KIT_GUIDE_URL);
  console.log();
}

// Get environment variables required for your auth solution
function getAuthEnvVariables(auth: Questions["auth"]) {
  const envVariables = {
    demo: [],
    github: [
      { key: "GITHUB_CLIENT_ID", value: "" },
      { key: "GITHUB_CLIENT_SECRET", value: "" },
    ],
    auth0: [
      { key: "AUTH0_CLIENT_ID", value: "" },
      { key: "AUTH0_CLIENT_SECRET", value: "" },
      { key: "AUTH0_ISSUER_BASE_URL", value: "" },
    ],
  };

  return envVariables?.[auth] || [];
}

// Add the selected auth provider code to a `[...nextauth].ts` file
function addAuthproviderSetup(
  auth: Questions["auth"],
  nextauthTs: string
): string {
  let newFileContent = nextauthTs;

  // RegExp for finding the content within the array: `providers: []`
  // Works so long as `providers` contains no nested arrays more than 3 layers deep
  const findProviders =
    /providers:[\s]*\[(?:[^\]\[]|\[(?:[^\]\[]|\[(?:[^\]\[]|\[[^\]\[]*])*])*])*]/;
  newFileContent = newFileContent.replace(
    findProviders,
    "providers: [" + getAuthProvider(auth) + "  ]"
  );

  // RegExp for finding CredentialsProvider import line
  // Works if import is on one single line
  const findImport = /^import[\s]+CredentialsProvider[\w\W]+?$/m;
  newFileContent = newFileContent.replace(
    findImport,
    getAuthProviderImport(auth)
  );

  return newFileContent;
}

// Get the selected auth provider initialization code
function getAuthProvider(auth: Questions["auth"]): string {
  const providers = {
    demo: demoAuthProvider,
    github: githubAuthProvider,
    auth0: auth0AuthProvider,
  };

  return providers?.[auth] || "";
}

// Get the select auth provider import code
function getAuthProviderImport(auth: Questions["auth"]): string {
  const imports = {
    demo: 'import CredentialsProvider from "next-auth/providers/credentials";',
    github: 'import GithubProvider from "next-auth/providers/github";',
    auth0: 'import Auth0Provider from "next-auth/providers/auth0";',
  };

  return imports?.[auth] || "";
}
