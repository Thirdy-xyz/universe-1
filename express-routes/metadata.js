const app = require("express").Router();
const Sentry = require("@sentry/node");
const axios = require("axios").default;
const d3 = import("d3");
const jsdom = require("jsdom");
const svgToMiniDataURI = require("mini-svg-data-uri");
var Prando = require("prando");
const { validateName } = require("../helpers/validate-community-name");
const sha3 = require("web3-utils").sha3;
const { ethers } = require("ethers");
const filter = require("../helpers/filter");
const { Service: _RegistrarService } = require("../services/RegistrarService");
const rateLimit = require("express-rate-limit");

const planet1 = require("../helpers/constants/metadata/planet1");
const planet2 = require("../helpers/constants/metadata/planet2");
const planet3 = require("../helpers/constants/metadata/planet3");
const planet4 = require("../helpers/constants/metadata/planet4");
const planet5 = require("../helpers/constants/metadata/planet5");
const planet6 = require("../helpers/constants/metadata/planet6");
const planet7 = require("../helpers/constants/metadata/planet7");
const planets = [planet1, planet2, planet3, planet4, planet5, planet6, planet7];

const { Metadata } = require("../models/Metadata");

const { JSDOM } = jsdom;

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 1_000, // 1s
  max: 1, // limit each IP to 1 requests per windowMs
  message: "Too many requests, please try again later.",
  handler: (req, res, next) => {
    res.status(429).send("Too many requests, please try again later.");
  },
});

app.use(limiter);

app.get("/domain/:domain", async (req, res) => {
  try {
    const inputDomain = req.params.domain;
    if (
      !inputDomain ||
      inputDomain.length == 0 ||
      inputDomain.length > 32 ||
      inputDomain.toLowerCase() != inputDomain
    ) {
      throw Error("inputDomain invalid!");
    }
    if (inputDomain.includes(".beb")) {
      if (inputDomain.split(".").length != 2) {
        throw Error("inputDomain cannot contain subdomains!");
      }
      const inputDomainSplit = inputDomain.split(".beb");
      if (inputDomainSplit[1].length > 0) {
        throw Error("inputDomain extension incorrect!");
      }
    } else if (inputDomain.includes(".")) {
      throw Error("inputDomain does not have correct extension!");
    }

    validateName(inputDomain);
    const rawDomain = inputDomain.replace(".beb", "");

    const existing = await Metadata.findOne({ uri: sha3(rawDomain) });
    if (existing) {
      return res.json({
        created: false,
        domain: existing.domain,
        uri: existing.uri,
      });
    }

    const metadata = await Metadata.create({
      domain: rawDomain,
      uri: sha3(rawDomain),
    });

    return res.json({
      created: true,
      domain: metadata.domain,
      uri: metadata.uri,
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.json({
      code: "500",
      success: false,
      message: e.message,
    });
  }
});

const bebLogo =
  '<svg height="100%" fill="rgb(0,0,0,0.6)" version="1" viewBox="100 -50 1280 1280"></svg>';

app.get("/uri/:uri", async (req, res) => {
  try {
    const uri = req.params.uri;

    if (!uri || uri.length == 0) {
      throw Error("uri invalid!");
    }
    const hexUri = ethers.BigNumber.from(uri).toHexString();
    let metadata = await Metadata.findOne({
      uri: hexUri,
    });
    if (!metadata) {
      metadata = { uri: hexUri, domain: "no_metadata_refresh_beb_domains" };
    }
    const rawDomain = metadata.domain;

    const fakeDom = new JSDOM("<!DOCTYPE html><html><body></body></html>");

    let body = (await d3).select(fakeDom.window.document).select("body");

    let rng = new Prando(rawDomain);

    const RegistrarService = new _RegistrarService();
    const owner = await RegistrarService.getOwner(rawDomain);
    if (!owner) {
      throw Error("Domain does not exist!");
    }

    let hsla = [
      rng.next(300),
      rng.next(300),
      rng.next(300),
      rng.next(300),
      rng.next(300),
      rng.next(300),
      rng.next(300),
    ];
    const index = Math.floor(hsla[0] % 7);

    const backgroundImage = `
    <svg width="500" height="500">
      <image href="${planets[index]}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice"></image>
    </svg>
  `;

    let svgContainer = body
      .append("div")
      .attr("class", "container")
      .append("svg")
      .attr("width", 500)
      .attr("height", 500)
      .attr("xmlns", "http://www.w3.org/2000/svg")
      .html(backgroundImage + bebLogo);

    let length = [...rawDomain].length;
    let base = 0.95;
    if (!rawDomain.match(/^[\u0000-\u007f]*$/)) {
      length = 2 * length;
    }

    const scoreDataUrl = "https://beb.xyz/api/score/" + owner + "?nft=true";
    const scoreData = await axios.get(scoreDataUrl);
    let addressScore = null;
    if (scoreData.data.score) {
      addressScore = parseInt(scoreData.data.score);
    }

    const colorMap = {
      free: "#5C9135",
      gold: "#D4AF37",
      platinum: "#E3C2C0",
      nova: "#fff",
    };
    let textColor = colorMap.free;
    if (addressScore && length < 10) {
      if (addressScore <= 500) {
        textColor = colorMap.gold;
      } else if (addressScore <= 650) {
        textColor = colorMap.platinum;
      } else {
        textColor = colorMap.nova;
      }
    }

    const dynamicfontsize = parseInt(80 * Math.pow(base, length));

    svgContainer
      .append("rect")
      .attr("x", 0)
      .attr("y", 195)
      .attr("height", 155)
      .attr("width", 500)
      .attr("fill", "#111111");

    svgContainer
      .append("text")
      .attr("x", 250)
      .attr("y", 255)
      .attr("font-size", `${dynamicfontsize}px`)
      .attr("font-family", "Helvetica, sans-serif")
      .attr("fill", textColor)
      .attr("text-anchor", "middle")
      .style("font-weight", "800")
      .style("text-shadow", "2px 2px #111111")
      .text(`${rawDomain}.beb`);

    if (addressScore) {
      addressScore = parseInt(scoreData.data.score);
      svgContainer
        .append("text")
        .attr("x", 250)
        .attr("y", 325)
        .attr("font-size", `48px`)
        .attr("font-family", "Helvetica, sans-serif")
        .attr("fill", textColor)
        .attr("text-anchor", "middle")
        .style("font-weight", "600")
        .style("text-shadow", "2px 2px #111111")
        .text(`BEB Score: ${addressScore}`);
    } else {
      console.error(`Could not get score data: ${scoreData}`);
    }

    const svg = body.select(".container").html();
    const image = svgToMiniDataURI(svg);
    console.log(svg);

    let data = {
      name: `${rawDomain}.beb`,
      owner,
      external_url: `https://${rawDomain}.beb.xyz`,
      description: `${rawDomain}.beb was registered on beb.domains! Learn about BEB Scores at: beb.xyz/reputation`,
      animation_url: `https://beb.domains/metadata/${uri}`,
      host: "https://protocol.beb.xyz/graphql",
      image,
      score: addressScore,
    };

    if (filter.isProfane(rawDomain) && process.env.MODE !== "self-hosted") {
      data = {
        name: `hidden_domain.beb`,
        description: `This domain is hidden, see beb.xyz/guidelines for more details!`,
      };
    }

    return res.json(data);
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.json({
      code: "500",
      success: false,
      message: e.message,
    });
  }
});

module.exports = {
  router: app,
};
