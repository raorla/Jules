import { createDatabase } from "@jules/db";
import { Keyring, SecretStore, parseMasterKey } from "@jules/secrets";
import pino from "pino";
import { Masker } from "../../src/broker/masking.js";
import { PlanService } from "../../src/devops/plans.js";
import { ServerService } from "../../src/devops/servers.js";

// Worker réduit au minimum pour le test d'interruption : il exécute les plans approuvés et se fait
// tuer (SIGKILL) au milieu d'une étape, comme un vrai worker qui tombe.

const database = createDatabase(process.env.DATABASE_URL ?? "", { max: 3 });
const store = new SecretStore(
  database.db,
  new Keyring(parseMasterKey(process.env.JULES_MASTER_KEY ?? "")),
);
const log = pino({ level: "silent" });
const servers = new ServerService({ db: database.db, secrets: store, masker: new Masker([]), log });
await new PlanService({ db: database.db, servers, log }).drain();
await database.close();
