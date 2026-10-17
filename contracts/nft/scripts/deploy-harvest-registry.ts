import { ethers, network } from "hardhat";

/**
 * Deploys HarvestRegistry to the network named "target" (DEPLOY_RPC_URL +
 * DEPLOYER_PRIVATE_KEY). The recorder is the hot key the worker signs with;
 * it gets RECORDER_ROLE only. The admin (default: the deployer) can later grant
 * the role to a new key if the recorder key is ever replaced.
 */
async function main() {
  const recorder = process.env.HARVEST_RECORDER_ADDRESS;
  if (!recorder || !ethers.isAddress(recorder)) throw new Error("set HARVEST_RECORDER_ADDRESS to the worker's signer address");
  const [deployer] = await ethers.getSigners();
  const admin = process.env.HARVEST_ADMIN_ADDRESS && ethers.isAddress(process.env.HARVEST_ADMIN_ADDRESS) ? process.env.HARVEST_ADMIN_ADDRESS : deployer!.address;

  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`Deploying HarvestRegistry to chain ${chainId} (${network.name}) from ${deployer!.address}`);
  const c = await (await ethers.getContractFactory("HarvestRegistry", deployer)).deploy(admin, recorder);
  await c.waitForDeployment();
  const tx = c.deploymentTransaction();
  console.log(`HARVEST_REGISTRY_ADDRESS=${await c.getAddress()}`);
  console.log(`CHAIN_ID=${chainId}`);
  console.log(`DEPLOY_TX=${tx?.hash ?? "unknown"}`);
  console.log(`ADMIN=${admin} RECORDER=${recorder}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
