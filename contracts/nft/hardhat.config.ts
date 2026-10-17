import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig } from "hardhat/config";

/**
 * Only the in-process Hardhat network and a local node are configured.
 * TODO(provider-config): add testnet/mainnet networks with an RPC URL and a
 * deployer key from your secret manager. Never commit keys; never deploy from
 * a key that also holds the admin role in production (see docs/threat-model.md).
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // A real network, configured only from the environment (used by the manual deploy workflow).
    ...(process.env.DEPLOY_RPC_URL && process.env.DEPLOYER_PRIVATE_KEY
      ? { target: { url: process.env.DEPLOY_RPC_URL, accounts: [process.env.DEPLOYER_PRIVATE_KEY] } }
      : {}),
  },
};

export default config;
