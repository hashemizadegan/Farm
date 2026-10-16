import { ethers } from "hardhat";

/**
 * Local deployment for development. Role holders default to separate local
 * accounts to model the production separation of duties.
 *
 * TODO(provider-config): for any real network, take ADMIN/MINTER/PAUSER
 * addresses from configuration; the admin should be a multisig, the minter a
 * hot key with only MINTER_ROLE, and the pauser a separate key or multisig.
 */
async function main() {
  const [deployer, admin, minter, pauser, definer] = await ethers.getSigners();
  const baseUri = process.env.NFT_BASE_URI ?? "http://localhost:4000/nft/metadata/";
  const maxSupply = BigInt(process.env.NFT_ERC721_MAX_SUPPLY ?? "10000");

  const erc721 = await (await ethers.getContractFactory("FarmProjectCollectible", deployer)).deploy(
    "Metafarm Project Collectible",
    "MFPC",
    baseUri,
    maxSupply,
    admin.address,
    minter.address,
    pauser.address,
  );
  const erc1155 = await (await ethers.getContractFactory("FarmSceneItems", deployer)).deploy(
    `${baseUri}items/{id}.json`,
    admin.address,
    minter.address,
    pauser.address,
    definer.address,
  );
  await Promise.all([erc721.waitForDeployment(), erc1155.waitForDeployment()]);
  console.log(`NFT_ERC721_ADDRESS=${await erc721.getAddress()}`);
  console.log(`NFT_ERC1155_ADDRESS=${await erc1155.getAddress()}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
