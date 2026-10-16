import { expect } from "chai";
import { ethers } from "hardhat";

describe("FarmSceneItems (ERC-1155)", () => {
  async function deploy() {
    const [admin, minter, pauser, definer, alice, bob, stranger] = await ethers.getSigners();
    const F = await ethers.getContractFactory("FarmSceneItems");
    const c = await F.deploy("https://example.invalid/items/{id}.json", admin.address, minter.address, pauser.address, definer.address);
    return { c, admin, minter, pauser, definer, alice, bob, stranger };
  }

  it("requires an item to be defined, once, before minting", async () => {
    const { c, minter, definer, alice, stranger } = await deploy();
    await expect(c.connect(minter).mint(alice.address, 7, 1)).to.be.revertedWithCustomError(c, "ItemNotDefined").withArgs(7n);
    await expect(c.connect(stranger).defineItem(7, 10)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await expect(c.connect(definer).defineItem(7, 10)).to.emit(c, "ItemDefined").withArgs(7n, 10n);
    await expect(c.connect(definer).defineItem(7, 1_000)).to.be.revertedWithCustomError(c, "ItemAlreadyDefined");
    await expect(c.connect(definer).defineItem(8, 0)).to.be.revertedWithCustomError(c, "ZeroMaxSupply");
  });

  it("enforces fixed per-item supply, including within a batch", async () => {
    const { c, minter, definer, alice } = await deploy();
    await c.connect(definer).defineItem(1, 5);
    await c.connect(minter).mint(alice.address, 1, 3);
    await expect(c.connect(minter).mint(alice.address, 1, 3)).to.be.revertedWithCustomError(c, "ExceedsMaxSupply");
    // Repeating the same id inside a batch must not bypass the cap.
    await expect(c.connect(minter).mintBatch(alice.address, [1, 1], [1, 2])).to.be.revertedWithCustomError(c, "ExceedsMaxSupply");
    await c.connect(minter).mintBatch(alice.address, [1, 1], [1, 1]);
    expect(await c["totalSupply(uint256)"](1)).to.equal(5n);
  });

  it("restricts minting to MINTER_ROLE", async () => {
    const { c, definer, alice, stranger } = await deploy();
    await c.connect(definer).defineItem(1, 5);
    await expect(c.connect(stranger).mint(alice.address, 1, 1)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
  });

  it("pause halts transfers without changing balances", async () => {
    const { c, minter, pauser, definer, alice, bob } = await deploy();
    await c.connect(definer).defineItem(1, 5);
    await c.connect(minter).mint(alice.address, 1, 2);
    await c.connect(pauser).pause();
    await expect(c.connect(alice).safeTransferFrom(alice.address, bob.address, 1, 1, "0x")).to.be.revertedWithCustomError(c, "EnforcedPause");
    expect(await c.balanceOf(alice.address, 1)).to.equal(2n);
    await c.connect(pauser).unpause();
    await c.connect(alice).safeTransferFrom(alice.address, bob.address, 1, 1, "0x");
    expect(await c.balanceOf(bob.address, 1)).to.equal(1n);
  });

  it("has no confiscation path", async () => {
    const { c, minter, admin, definer, alice, bob } = await deploy();
    await c.connect(definer).defineItem(1, 5);
    await c.connect(minter).mint(alice.address, 1, 1);
    await expect(c.connect(admin).safeTransferFrom(alice.address, bob.address, 1, 1, "0x")).to.be.revertedWithCustomError(c, "ERC1155MissingApprovalForAll");
    const names = c.interface.fragments.map((f) => ("name" in f ? f.name : "")).filter(Boolean);
    for (const forbidden of ["burn", "burnBatch", "adminTransfer", "confiscate", "seize", "setMaxSupply", "raiseSupply"]) {
      expect(names).to.not.include(forbidden);
    }
  });
});
