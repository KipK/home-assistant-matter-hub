import "@matter/nodejs";
import { WebApi } from "../api/web-api.js";
import { BridgeService } from "../matter/bridge-service.js";
import { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { createLogger } from "../logging/create-logger.js";
import { HomeAssistantClient } from "../home-assistant/home-assistant-client.js";
import * as ws from "ws";
import { BridgeBasicInformation } from "@home-assistant-matter-hub/common";
import { Service } from "../utils/service.js";
import { matterJsLogger } from "../logging/matter-js-logger.js";
import _ from "lodash";
import {
  Environment,
  Logger as MatterLogger,
  StorageService,
  VendorId,
} from "@matter/main";
import fs from "node:fs";
import { customLogger } from "../logging/custom-logger.js";
import { createEnvironment } from "../environment/environment.js";

interface Options {
  "log-level": string;
  "web-port": number;
  "disable-log-colors": boolean;
  "storage-location"?: string;
  "mdns-network-interface"?: string;
  "home-assistant-url": string;
  "home-assistant-access-token": string;
}

const basicInformation: BridgeBasicInformation = {
  vendorId: VendorId(0xfff1),
  vendorName: "t0bst4r",
  productId: 0x8000,
  productName: "MatterHub",
  productLabel: "Home Assistant Matter Hub",
  hardwareVersion: 2024,
  softwareVersion: 2024,
};

function builder(yargs: Argv): Argv<Options> {
  return yargs
    .version(false)
    .config(
      "config",
      'Provide the path to a configuration JSON file, which can include all the other command options. You can use kebabcase ("log-level") or camelcase ("logLevel").',
      (configPath) => {
        if (configPath.trim() === "") {
          return {};
        }
        if (!fs.existsSync(configPath)) {
          throw new Error(`Config file '${configPath}' does not exist!`);
        }
        return JSON.parse(fs.readFileSync(configPath, "utf-8"));
      },
    )
    .option("log-level", {
      type: "string",
      choices: ["silly", "debug", "info", "warn", "error"],
      default: "info",
    })
    .option("disable-log-colors", {
      type: "boolean",
      default: false,
    })
    .option("storage-location", {
      type: "string",
      description:
        "Path to a directory where the application should store its data. Defaults to $HOME/.home-assistant-matter-hub",
    })
    .option("web-port", {
      type: "number",
      description: "Port used by the web application",
      default: 8482,
    })
    .option("mdns-network-interface", {
      type: "string",
      description: "Limit MDNS to this network interface",
    })
    .option("home-assistant-url", {
      type: "string",
      description: "The HTTP-URL of your Home Assistant URL",
    })
    .option("home-assistant-access-token", {
      type: "string",
      description: "A long-lived access token for your Home Assistant Instance",
    })
    .demandOption(["home-assistant-url", "home-assistant-access-token"]);
}

async function handler(
  options: ArgumentsCamelCase<Options>,
  webUiDist?: string,
): Promise<void> {
  Object.assign(globalThis, {
    WebSocket: globalThis.WebSocket ?? ws.WebSocket,
  });

  customLogger.configure(options.logLevel, !options.disableLogColors);
  MatterLogger.level = "debug";
  MatterLogger.log = matterJsLogger();

  const environment = createEnvironment(Environment.default, {
    mdnsNetworkInterface: options.mdnsNetworkInterface,
    storageLocation: options.storageLocation,
  });

  const homeAssistant = new HomeAssistantClient({
    url: options.homeAssistantUrl,
    accessToken: options.homeAssistantAccessToken,
  });

  const bridgeService = new BridgeService({
    environment,
    storage: await environment.get(StorageService).open("app"),
    basicInformation,
    homeAssistant,
  });

  const webApi = new WebApi({
    bridgeService,
    port: options.webPort,
    webUiDist,
  });

  const services: Service[] = [homeAssistant, bridgeService, webApi];
  for (const service of services) {
    await service.start?.();
  }
  const close = closeFn(_.reverse(services));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

function closeFn(services: Service[]): (evt: string) => Promise<void> {
  const log = createLogger("Close Handler");
  return async (evt: string) => {
    log.info("Received %s, shutting down", evt);
    for (const service of services) {
      log.debug("Shutting down %s", service.serviceName);
      await service.close?.()?.catch((reason) => {
        log.warn("Failed to close %s: %s", service, reason);
      });
      log.debug("%s shut down", service.serviceName);
    }
    process.exit(0);
  };
}

function startCommand(webDist?: string): CommandModule<{}, Options> {
  return {
    command: "start",
    describe: "start the application",
    builder,
    handler: (args) => handler(args, webDist),
  };
}

export default startCommand;
