
import { ethers } from 'hardhat'
import { formatEther, parseEther } from 'ethers/lib/utils';
const colors = require('colors/safe');
import { updateABI, verify } from './util';

async function main() {
    const [deployer] = await ethers.getSigners();
    if (deployer === undefined) throw new Error("Deployer is undefined.");
    console.log(
        colors.cyan("Deployer Address: ") + colors.yellow(deployer.address)
    );
    console.log(
        colors.cyan("Account balance: ") +
        colors.yellow(formatEther(await deployer.getBalance()))
    );
    console.log();

    let contractName = "CountryList";
    let contractFactory = await ethers.getContractFactory(contractName);
    const countryListContract = await contractFactory.deploy()
    await countryListContract.deployed();
    console.log("CountryList", countryListContract.address);
    await updateABI(contractName);


    const factory = "0x79D0b125CEA315aAB0Bb1BC2322287D3EBB88E47";
    contractName = "UniswapV2Locker";
    contractFactory = await ethers.getContractFactory(contractName);
    const uniswapV2Locker = await contractFactory.deploy(factory, countryListContract.address)
    await uniswapV2Locker.deployed();
    console.log("uniswapV2Locker", uniswapV2Locker.address);
    await updateABI(contractName);
    

}

main()
    .then(async (r: any) => {
        console.log("");
        return r;
    })
    .catch(error => {
        console.log(colors.red("ERROR :("));
        console.log(colors.red(error));
        return undefined;
    })


