const Sentry = require("@sentry/node");
const dotenv = require("dotenv");
const express = require("express");
const { resolvers } = require("./graphql/resolvers");

const { loadSchemaSync } = require("@graphql-tools/load");
const { makeExecutableSchema } = require("@graphql-tools/schema");
const { GraphQLFileLoader } = require("@graphql-tools/graphql-file-loader");
const { connectDB, MongodbPubSub: PubSub } = require("./connectdb");
const { router: imageRouter } = require("./express-routes/image");
const { router: utilsRouter } = require("./express-routes/utils");
const { router: communityRouter } = require("./express-routes/community");
const { router: metadataRouter } = require("./express-routes/metadata");
const {
  router: publicProfileRouter,
} = require("./express-routes/ens-or-address");
const { router: ensRouter } = require("./express-routes/ens");
const { requireAuth } = require("./helpers/auth-middleware");
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@apollo/server/express4");
const {
  ApolloServerPluginDrainHttpServer,
} = require("@apollo/server/plugin/drainHttpServer");
const http = require("http");
const cors = require("cors");
const { json } = require("body-parser");
const { useServer } = require("graphql-ws/lib/use/ws");
const WebSocket = require("ws");

const port = parseInt(process.env.PORT, 10) || 8080;

const typeDefs = loadSchemaSync(
  ["./graphql/typeDefs/*.gql", "./graphql/typeDefs/**/*.gql"],
  { loaders: [new GraphQLFileLoader()] }
);

const schema = makeExecutableSchema({ typeDefs, resolvers });

const { createDataLoaders } = require("./graphql/dataloaders");
const app = express();
const httpServer = http.createServer(app);
const wsServer = new WebSocket.Server({ server: httpServer, path: "/graphql" });

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 1.0,
  });
}

(async () => {
  require("yargs").command(
    "$0",
    "Start your Universe",
    (yargs) => {
      yargs.option("self-hosted", {
        type: "boolean",
        default: false,
        description: "Run Universe in self-hosted mode",
      });
      yargs.option("env", {
        type: "string",
        default: ".env",
        description: "Path to .env file",
      });
      yargs.option("use-ws", {
        type: "boolean",
        default: false,
        description:
          "Create a websocket server to server GraphQL subscriptions",
      });
    },
    async (argv) => {
      dotenv.config({ path: argv.env });
      const shouldUseWs = argv.useWs;
      process.env.MODE = argv.selfHosted ? "self-hosted" : "default";

      let REQUIRED_ENV_VARS = ["JWT_SECRET", "MONGO_URL", "NODE_ENV"];

      if (process.env.MODE === "self-hosted") {
        console.log(`Universe is running in self-hosted mode! 😎`);
      } else {
        console.log(`Universe is running in default mode! 👀`);
        REQUIRED_ENV_VARS = REQUIRED_ENV_VARS.concat([
          "IMGUR_CLIENT_ID",
          "MAGIC_LINK_SECRET",
          "IMGUR_CLIENT_ID",
          "EXPO_ACCESS_TOKEN",
          "BEB_FARCASTER_APP_TOKEN",
          "SENTRY_DSN",
          "HOMESTEAD_NODE_URL",
        ]);
      }

      if (shouldUseWs) {
        console.log(
          `⚠️  (Experimental) Enabling a websocket server with GraphQL subscriptions (--use-ws)! Performance will be degraded.`
        );
      } else {
        console.log(
          `👀 Using HTTP-only GraphQL, Websockets and subscriptions are disabled (see --use-ws).`
        );
      }

      const passed = REQUIRED_ENV_VARS.filter((envVar) => {
        if (!process.env[envVar]) {
          console.error(
            `${envVar} is not set. Please set it (e.g. .env file)!`
          );
          return true;
        }
      });

      if (passed.length > 0) {
        console.error("Exiting...");
        process.exit(1);
      }

      if (process.env.JWT_SECRET === "change-this") {
        console.error(
          "Please change your JWT_SECRET from the default! (e.g. .env file)"
        );
        process.exit(1);
      }
      await connectDB();
      const dataloaders = createDataLoaders();

      let wsServerCleanup = null;

      if (shouldUseWs) {
        const wsServer = new WebSocket.Server({
          server: httpServer,
          path: "/graphql",
        });
        const pubSub = new PubSub({
          mongooseOptions: {
            url: process.env.MONGO_URL,
            useNewUrlParser: true,
          },
        });
        wsServerCleanup = useServer(
          {
            // execute,
            // subscribe,
            schema,
            onClose: () => console.log("WebSocket server closed."),
            context: async (ctx) => {
              try {
                const data = await requireAuth(
                  ctx.connectionParams?.authorization?.slice(7) || ""
                );
                return {
                  accountId: data.payload.id,
                  dataloaders,
                  pubSub,
                };
              } catch (e) {
                try {
                  if (!e.message.includes("jwt must be provided")) {
                    Sentry.captureException(e);
                    console.error(e);
                  }
                  return { dataloaders, pubSub };
                } catch (e) {
                  Sentry.captureException(e);
                  console.error(e);
                  return {};
                }
              }
            },
          },
          wsServer
        );
      }
      const server = new ApolloServer({
        schema,
        introspection: true,
        cache: "bounded",
        csrfPrevention: true,
        formatError: (e) => {
          Sentry.captureException(e);
          console.error(e);
          return new Error("Internal server error");
        },
        plugins: [
          // Proper shutdown for the HTTP server.
          ApolloServerPluginDrainHttpServer({ httpServer }),

          // Proper shutdown for the WebSocket server.
          {
            async serverWillStart() {
              return {
                async drainServer() {
                  if (!shouldUseWs) {
                    console.log("Skipping WebSocket server...");
                    return;
                  }
                  console.log("Draining WebSocket server...");
                  await wsServerCleanup?.dispose?.();
                },
              };
            },
          },
        ],
      });

      await server.start();
      app.use(
        "/graphql",
        cors(),
        json(),
        expressMiddleware(server, {
          context: async ({ req }) => {
            try {
              const data = await requireAuth(
                req.headers.authorization?.slice(7) || ""
              );
              return {
                accountId: data.payload.id,
                dataloaders,
              };
            } catch (e) {
              try {
                if (!e.message.includes("jwt must be provided")) {
                  Sentry.captureException(e);
                  console.error(e);
                }
                return { dataloaders };
              } catch (e) {
                Sentry.captureException(e);
                console.error(e);
                return {};
              }
            }
          },
        })
      );

      app.get("/", (_req, res) => {
        res.json({
          message:
            "Welcome to a BEB Dimensions Host running github.com/bebverse/universe, see /graphql for the API!",
        });
      });

      app.get("/health", (_req, res) => {
        res.status(200).send("Okay!");
      });

      app.use(express.json());
      app.use(function (req, res, next) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Origin, X-Requested-With, Content-Type, sentry-trace, Accept, Authorization, baggage"
        );

        next();
      });

      app.use("/image", imageRouter);
      app.use("/profile", publicProfileRouter);
      app.use("/community", communityRouter);
      app.use("/metadata", metadataRouter);
      app.use("/utils", utilsRouter);
      app.use("/ens/", ensRouter);

      await new Promise((resolve) =>
        httpServer.listen({ port: port }, resolve)
      );

      console.log(`🚀 Universe is running at http://localhost:${port}/graphql`);
    }
  ).argv;
})();
