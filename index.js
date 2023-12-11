const { Telegraf } = require("telegraf")
const { message } = require("telegraf/filters")
const ethers = require("ethers")

const fs = require("fs")
const path = require("path")
const axios = require('axios')
const { Worker } = require('worker_threads')
//const { exec } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const solanaWeb3 = require('@solana/web3.js');

const { NFTStorage, File } = require('nft.storage')
const mime = require('mime')
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const dotenv = require("dotenv")
dotenv.config()

const BOT_NAME = 'Snow Laucher Bot'
const PLATFORM_FEE_ADDRESS_1 = process.env.FEE_ADDRESS1

const TokenBin = require("./resources/TokenArtifact.json")
const TokenAbi = TokenBin.abi;
const LPABI = require("./resources/LPABI.json")

const RouterAbi = require("./resources/UniswapV2Router.json")
const UniswapV2LockerAbi_v8 = require("./resources/UniswapV2Locker8.json")

const MINIMUM_ETH_LP = 0.01
const TESTNET_SHOW = process.env.TESTNET_SHOW == 1 ? true : false

const SUPPORTED_CHAINS = [
    // {
    //     id: 31337, name: 'Localnet', rpc: 'http://127.0.0.1:8545', symbol: 'ETH', router: '0xFd0c6D2899Eb342b9E48abB3f21730e9F4532976', limit: 0.0001, apiKey: process.env.ETH_APIKEY, verifyApiUrl: "https://api.etherscan.io/api"
    // },
    {
        id: 43113,
        name: 'Avalanche Testnet',
        hardhatChainname: "fuji",
        rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
        symbol: 'AVAX',
        router: '0x3705aBF712ccD4fc56Ee76f0BD3009FD4013ad75', // PartySwap
        //router: '0x2D99ABD9008Dc933ff5c0CD271B88309593aB921', // Pangolin
        locker: ['uncx', '0xB9EC89595B5106c9b673c2b10B1C6E7a7D2dD264', UniswapV2LockerAbi_v8],
        limit: 0.01,
        scanUrl: "https://testnet.snowtrace.io",
        testnet: true
    },
    {
        id: 43114,
        name: 'Avalanche Mainnet',
        hardhatChainname: "avalanche",
        rpc: 'https://api.avax.network/ext/bc/C/rpc',
        symbol: 'AVAX',
        router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4', // TraderJoe
        locker: ['uncx', '0xCdFfdddCe83597A81082Dc13b3b8ff1218f7f564', UniswapV2LockerAbi_v8],
        limit: 2,
        scanUrl: "https://snowtrace.io/",
        testnet: false,
    },
]


const INPUT_CAPTIONS = {
    pvkey: 'Please paste or enter private key of deployer wallet',
    symbol: 'Please enter symbol for the token',
    name: 'Please enter name for the token',
    supply: 'Please enter total supply for the token. (Do not enter commas)',
    buyTax: 'Please enter Buy percentage of token',
    sellTax: 'Please enter Sell percentage of token',
    burnPerTx: 'Please enter Burn percentage of token',
    taxReceiver: 'Please enter address of Tax receiver',
    preMint: 'Please enter amount of pre-minted to owner',
    ethLP: `Please enter AVAX amount to add Liquidity`,
    maxPerWallet: 'Please enter Max percent of supply per Wallet',
    maxPerTx: 'Please enter Max percent of supply per Tx',
    lockTime: 'Please enter days for Custom duration to Lock',
    bridgeAmount: 'Please enter amount to Bridge',
    bridgeTo: 'Please enter the destination wallet address to Bridge',
    mixerAmount: 'Please enter amount to Mixer',
    mixerReceiverAddress: 'Please enter target receiver address',
    reflectionTokenAddress: 'Please enter address of reflection token',
    reflectionPercentage: 'Please enter reflection perentage',
    website: 'Please enter website url',
    telegram: 'Please enter telegram url',
    x: 'Please enter X url'
}

const { escape_markdown } = require("./common/utils")
const { error } = require("console")
const createBot = () => {
    const token = process.env.BOT_TOKEN
    if (process.env.BOT_PROXY) {
        const [host, port] = process.env.BOT_PROXY.split(':')
        const HttpsProxyAgent = require('https-proxy-agent')
        const agent = new HttpsProxyAgent({ host, port })
        return new Telegraf(token, {
            telegram: { agent },
            handlerTimeout: 9_000_000
        })
    }
    return new Telegraf(token, {
        handlerTimeout: 9_000_000
    })
}

const bot = createBot()

// const token = process.env.BOT_TOKEN
// const bot = new Telegraf(token, {
//     handlerTimeout: 9_000_000
// })

// const menuMiddleware = new MenuMiddleware('/', context => {
//     console.log('Menu button pressed', context.match)
// });

bot.use(async (ctx, next) => {
    const t = Date.now()
    const res = await next()
    console.log(ctx.match?.input, Date.now() - t)
    return res
})

const states = {}
const tradings = {}

const state = (ctx, values) => {
    if (!values) {
        const defaultChain = SUPPORTED_CHAINS.find(chain => TESTNET_SHOW ? true : !chain.testnet)
        return {
            chainId: defaultChain.id,
            mixerReceiverAddress: "",
            token: { lockTime: 30 },
            trading: {},
            bridgeAmount: 1,
            mixerAmount: 0,
            ...(
                process.env.DEBUG_PVKEY ? {
                    pvkey: process.env.DEBUG_PVKEY,
                    account: new ethers.Wallet(process.env.DEBUG_PVKEY).address
                } : {}
            ),
            ...states[ctx.chat.id]
        }
    }
    states[ctx.chat.id] = {
        ...(states[ctx.chat.id] ?? {}), ...values
    }
}

const tokens = (ctx, token, update = false) => {
    const filepath = path.resolve(`./data/tokens-${ctx.chat.id}.json`)
    const data = fs.existsSync(filepath) ? JSON.parse(fs.readFileSync(filepath)) : []
    const { chainId, account } = state(ctx)
    if (!token)
        return data.filter(token => token.chain == chainId && token.deployer == account)
    if (update)
        fs.writeFileSync(filepath, JSON.stringify(data.map(t => t.chain == chainId && t.address == token.address ? { ...t, ...token } : t)))
    else
        fs.writeFileSync(filepath, JSON.stringify([...data, token]))
}

const create = (ctx, caption, buttons) => {
    if (!ctx)
        return
    return ctx.telegram.sendMessage(ctx.chat.id, escape_markdown(caption), {
        parse_mode: "MarkdownV2",
        reply_markup: {
            inline_keyboard: buttons
        }
    }).catch(ex => { console.log(ex) })
}

const update = async (ctx, caption, buttons = [], must = false) => {
    if (!ctx)
        return

    if (must == true) {
        return await ctx.telegram.sendMessage(ctx.chat.id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    }
    else if (ctx.update?.callback_query) {
        const msg = ctx.update.callback_query.message
        return await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, msg.message_id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    } else if (ctx.message_id) {
        return await ctx.telegram.editMessageText(ctx.chat.id, ctx.message_id, ctx.message_id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    } else {
        return await ctx.telegram.sendMessage(ctx.chat.id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    }
}

const aggrAddress = (address) => `${address.substring(0, 10)}...${address.substring(38)}`

const showWelcome = async (ctx) => {
    const { chainId, pvkey } = state(ctx)
    state(ctx, { mixerStatus: false, mixerAmount: 0, mixerReceiverAddress: "" });
    return update(ctx, `Welcome to ${BOT_NAME}!`, [
        [
            {
                text: `Deploy`,
                callback_data: `back@deploy`,
            }
        ]
    ])
}


const showStart = async (ctx) => {
    const { chainId, pvkey } = state(ctx)
    if (pvkey)
        return showWallet(ctx)

    return update(ctx, `Setup your wallet to start using ${BOT_NAME}!`, [
        TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })) : [],
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })),
        [
            {
                text: `Connect Wallet`,
                callback_data: `back@account`,
            }
        ]
    ])
}

const showAccount = (ctx) => {
    const { pvkey } = state(ctx)
    update(ctx, 'Setup your Account', [
        pvkey ? [
            {
                text: `🔌 Disconnect`,
                callback_data: `disconnect`,
            }
        ] : [],
        [
            {
                text: `🔐 Existing private Key`,
                callback_data: `existing`,
            },
            {
                text: `🔑 Generate private Key`,
                callback_data: `generate`,
            }
        ],
        [
            {
                text: `🔙 Back`,
                callback_data: `back@start`,
            }
        ]
    ])
}

const showWallet = async (ctx) => {
    const { chainId, pvkey } = state(ctx)
    if (!pvkey)
        return showStart(ctx)
    const wallet = new ethers.Wallet(pvkey)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const balance = await provider.getBalance(wallet.address)


    return update(ctx, ['🧳 Wallet', `🔑 Address: "${wallet.address}"`, `📈 ${chain.symbol} balance: "${ethers.utils.formatEther(balance)}" Ξ`].join('\n'), [
        TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })) : [],
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })),
        [
            {
                text: `📝 Deploy Token`,
                callback_data: `back@deploy`,
            },
            {
                text: `📋 List Deployed Tokens`,
                callback_data: `back@list`,
            }
        ],
        [
            {
                text: `🛠️ Settings`,
                callback_data: `back@account`,
            }
        ],
        [
            {
                text: `🔌 Disconnect`,
                callback_data: `disconnect`,
            }
        ]
    ])
}

const showWait = async (ctx, caption) => {
    return update(ctx, `⌛ ${caption}`)
}

const showPage = (ctx, page) => {
    if (page == 'start')
        showStart(ctx)
    else if (page == 'account')
        showAccount(ctx)
    else if (page == 'key')
        showAccount(ctx)
    else if (page == 'wallet')
        showWallet(ctx)
    else if (page == 'deploy')
        showDeploy(ctx)
    else if (page == 'list')
        showList(ctx)
    else if (page == 'bridges')
        showBridges(ctx)
    else if (page == 'missions')
        showMissions(ctx)
    else if (page == 'mixer')
        showMixer(ctx, true)
    else if (/^token@(?<address>0x[\da-f]{40})$/i.test(page)) {
        const match = /^token@(?<address>0x[\da-f]{40})$/i.exec(page)
        if (match && match.groups.address)
            showToken(ctx, match.groups.address)
    } else if (/^bridge@(?<bridgeId>.+)$/.test(page)) {
        const match = /^bridge@(?<bridgeId>.+)$/i.exec(page)
        if (match && match.groups.bridgeId)
            showBridge(ctx, match.groups.bridgeId)
    } else
        showWelcome(ctx)
}

const showError = async (ctx, error, href, duration = 10000) => {
    // showPage(ctx, href)
    const err = await create(ctx, `⚠ ${error}`)
    if (duration)
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, err.message_id).catch(ex => { }), duration)
}

const showSuccess = async (ctx, message, href, duration = 10000) => {
    if (duration) setTimeout(() => showPage(ctx, href), duration)
    return update(ctx, `${message}`, [
        [
            {
                text: '🔙 Back',
                callback_data: `back@${href}`
            }
        ]
    ])
}

const showList = async (ctx) => {
    const { chainId, pvkey } = state(ctx)



    if (!pvkey)
        return showAccount(ctx)
    const wallet = new ethers.Wallet(pvkey)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const balance = await provider.getBalance(wallet.address)
    const deployed = tokens(ctx)
    // console.log(deployed)


    return update(ctx, ['🧳 Wallet', `🔑 Address: "${wallet.address}"`, `📈 ${chain.symbol} balance: "${ethers.utils.formatEther(balance)}" Ξ`].join('\n'), [
        TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })) : [],
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })),
        ...deployed.map(token =>
            [
                {
                    text: `${token.name} (${token.symbol}) at ${token.address}`,
                    callback_data: `token@${token.address}`
                }
            ]),
        [
            {
                text: `🔙 Back`,
                callback_data: `back@wallet`,
            }
        ]
    ])

}

const showDeploy = async (ctx) => {
    const { chainId, pvkey, token } = state(ctx)
    if (!pvkey)
        return showStart(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)

    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const wallet = new ethers.Wallet(pvkey, provider)
    const balance = await wallet.getBalance()
    const limit = ethers.utils.parseEther(String(MINIMUM_ETH_LP)).mul(1005).div(1000).add(ethers.utils.parseEther(String(chain.limit)))
    if (balance.lt(limit))
        showError(ctx, `Insufficient ${chain.symbol} balance!\nYou should have at least "${ethers.utils.formatEther(limit)} ${chain.symbol}" in wallet`)


    return update(ctx, [
        '🧳 Token Parameters',
        '',
        `${token.symbol ? '✅' : '❌'} Symbol: "${token.symbol?.toUpperCase() ?? 'Not set'}"`,
        `${token.name ? '✅' : '❌'} Name: "${token.name ?? 'Not set'}"`,
        `${token.supply ? '✅' : '❌'} Supply: "${token.supply ?? 'Not set'}"`,
        `${token.burnPerTx ? '✅' : '❔'} Burn percent: "${token.burnPerTx ? `${token.burnPerTx}%` : 'Not set'}"`,
        `${token.buyTax ? '✅' : '❔'} Buy Tax: "${token.buyTax ? `${token.buyTax}%` : 'Not set'}"`,
        `${token.sellTax ? '✅' : '❔'} Sell Tax: "${token.sellTax ? `${token.sellTax}%` : 'Not set'}"`,
        `✅ Tax Receiver: "${aggrAddress(token.taxReceiver ?? wallet.address)}"`,
        `${token.preMint ? '✅' : '❔'} Pre Mint: "${token.preMint ?? 'Not set'}"`,
        `${token.ethLP ? '✅' : '❌'} ${chain.symbol} LP: "${token.ethLP ?? 'Not set'}"`,
        `${token.maxPerWallet ? '✅' : '❔'} Max per Wallet: "${token.maxPerWallet ? `${token.maxPerWallet}%` : 'Not set'}"`,
        `${token.maxPerTx ? '✅' : '❔'} Max per Tx: "${token.maxPerTx ? `${token.maxPerTx}%` : 'Not set'}"`,
        `${token.reflectionTokenAddress ? '✅' : '❔'} Reflection Token Address: "${token.reflectionTokenAddress ? `${token.reflectionTokenAddress}` : 'Not set'}"`,
        `${token.reflectionPercentage ? '✅' : '❔'} Reflection Percentage: "${token.reflectionPercentage ? `${token.reflectionPercentage}%` : 'Not set'}"`,
        `${token.website ? '✅' : '❔'} Website: "${token.website ? `${token.website}` : 'Not set'}"`,
        `${token.telegram ? '✅' : '❔'} Telegram: "${token.telegram ? `${token.telegram}` : 'Not set'}"`,
        `${token.x ? '✅' : '❔'} X: "${token.x ? `${token.x}` : 'Not set'}"`,

    ].join('\n'), [
        TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })) : [],
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })),
        [
            {
                text: `💲 Symbol`,
                callback_data: `input@symbol`,
            },
            {
                text: `🔠 Name`,
                callback_data: `input@name`,
            },
            {
                text: `🔢 Supply`,
                callback_data: `input@supply`,
            }
        ],
        [
            {
                text: `🟢 Buy Tax`,
                callback_data: `input@buyTax`,
            },
            {
                text: `🔴 Sell Tax`,
                callback_data: `input@sellTax`,
            },
            {
                text: `🔥 Burn`,
                callback_data: `input@burnPerTx`,
            },
        ],
        [
            {
                text: `💵 Tax Receiver`,
                callback_data: `input@taxReceiver`,
            },
            {
                text: `💰 Pre Mintable`,
                callback_data: `input@preMint`,
            },
            {
                text: `💱 ${chain.symbol} LP amount`,
                callback_data: `input@ethLP`,
            },
        ],
        [
            {
                text: `*️⃣ Reflection %`,
                callback_data: `input@reflectionPercentage`,
            },
            {
                text: `📄 Reflection Token`,
                callback_data: `input@reflectionTokenAddress`,
            },
        ],
        [
            {
                text: `🚫 Max token per wallet`,
                callback_data: `input@maxPerWallet`,
            },
            {
                text: `🚫 Max token per TX`,
                callback_data: `input@maxPerTx`,
            }
        ],
        [
            {
                text: `🌐 Website`,
                callback_data: `input@website`,
            },
            {
                text: `➤ Telegram`,
                callback_data: `input@telegram`,
            },
            {
                text: `𝕏 (Twitter)`,
                callback_data: `input@x`,
            }
        ],
        [
            {
                text: `📝 Review and Deploy`,
                callback_data: `confirm@deploy`,
            }
        ],
        [
            {
                text: `🔙 Back`,
                callback_data: `back@wallet`,
            }
        ],
        Object.keys(token).length ? [
            {
                text: `🔄 Restart`,
                callback_data: `reset`,
            }
        ] : []
    ])

}

const showToken = async (ctx, address) => {
    let { chainId, pvkey, token: { lockTime, buyTax, sellTax } } = state(ctx)

    if (!pvkey)
        return showWallet(ctx)
    const token = tokens(ctx).find(token => token.chain == chainId && token.address == address)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)

    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const wallet = new ethers.Wallet(pvkey, provider)
    const Token = new ethers.Contract(token.address, TokenAbi, wallet)
    const lpPair = await Token.lpPair()
    const LP = new ethers.Contract(lpPair, LPABI, wallet)
    const lpBalance = await LP.balanceOf(wallet.address)
    console.log(lpBalance)

    return update(ctx, [
        '🧳 Token Parameters',
        '',
        `✅ Address: "${token.address}"`,
        `${token.symbol ? '✅' : '❌'} Symbol: "${token.symbol?.toUpperCase() ?? 'Not set'}"`,
        `${token.name ? '✅' : '❌'} Name: "${token.name ?? 'Not set'}"`,
        `${token.supply ? '✅' : '❌'} Supply: "${token.supply ?? 'Not set'}"`,
        `${token.burnPerTx ? '✅' : '❔'} Burnt percent: "${token.burnPerTx ? `${token.burnPerTx}%` : 'Not set'}"`,
        `${token.buyTax ? '✅' : '❔'} Buy Tax: "${token.buyTax ? `${token.buyTax}%` : 'Not set'}"`,
        `${token.sellTax ? '✅' : '❔'} Sell Tax: "${token.sellTax ? `${token.sellTax}%` : 'Not set'}"`,
        `✅ Tax Receiver: "${aggrAddress(token.taxReceiver ?? wallet.address)}"`,
        `${token.preMint ? '✅' : '❔'} Pre Mint: "${token.preMint ?? 'Not set'}"`,
        `${token.ethLP ? '✅' : '❌'} ${chain.symbol} LP: "${token.ethLP ?? 'Not set'}"`,
        `${token.maxPerWallet ? '✅' : '❔'} Max per Wallet: "${token.maxPerWallet ? `${token.maxPerWallet}%` : 'Not set'}"`,
        `${token.maxPerTx ? '✅' : '❔'} Max per Tx: "${token.maxPerTx ? `${token.maxPerTx}%` : 'Not set'}"`,
        `${token.reflectionTokenAddress ? '✅' : '❔'} Reflection Token Address: "${token.reflectionTokenAddress ? `${token.reflectionTokenAddress}` : 'Not set'}"`,
        `${token.reflectionPercentage ? '✅' : '❔'} Reflection Percentage: "${token.reflectionPercentage ? `${token.reflectionPercentage}%` : 'Not set'}"`,
    ].join('\n'), [
        TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })) : [],
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })),
        lpBalance._hex === "0x00" ?
            [
                {
                    text: `💱 Add Liquidity`,
                    callback_data: `confirm@addliquidity#${token.address}`,
                }
            ] :
            [

            ],
        ...(token.locked || !chain.locker ? [] : [
            [

                {
                    text: `📝 Lock LPs with following duration settings`,
                    callback_data: `confirm@lock#${token.address}`,
                }
            ],
            [
                {
                    text: `${lockTime == 30 ? '🟢' : '⚪'} 1 month`,
                    callback_data: `lockTime@1m#${token.address}`
                },
                {
                    text: `${lockTime == 180 ? '🟢' : '⚪'} 6 months`,
                    callback_data: `lockTime@6m#${token.address}`
                },
                {
                    text: `${lockTime == 365 ? '🟢' : '⚪'} 1 year`,
                    callback_data: `lockTime@1y#${token.address}`
                },
                {
                    text: `${[30, 180, 365].includes(lockTime) ? '⚪ Custom' : `🟢 ${lockTime} days`}`,
                    callback_data: `input@lockTime#${token.address}`
                }
            ]
        ]),
        lpBalance._hex !== "0x00" ?
            [
                {
                    text: `💱 Burn Liquidity`,
                    callback_data: `confirm@burnliquidity#${token.address}`,
                }
            ]
            : [],
        token.renounced ? [] : [
            {
                text: `📝 Renounce Ownership`,
                callback_data: `confirm@renounce#${token.address}`,
            }
        ],
        [
            {
                text: `📝 Update buy/sell tax`,
                callback_data: `confirm@update#${token.address}`,
            }
        ],
        [
            {
                text: `🟢 Buy Tax ${buyTax && token.buyTax != buyTax ? `(${buyTax}%)` : ''}`,
                callback_data: `input@buyTax#${token.address}`,
            },
            {
                text: `🔴 Sell Tax ${sellTax && token.sellTax != sellTax ? `(${sellTax}%)` : ''}`,
                callback_data: `input@sellTax#${token.address}`,
            }
        ],
        [
            {
                text: `🔙 Back`,
                callback_data: `back@list`,
            }
        ]
    ])

}

function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (err) {
        return false;
    }
}

function replaceWebsite(website) {
    const TokenSourceCode = fs.readFileSync("./contracts/Token.sol").toString('utf8');
    const replaced = TokenSourceCode.replace("Website:", "Website: " + website);
    fs.writeFileSync("./contracts/Token.sol", replaced);
}

function replaceTelegram(telegram) {
    const TokenSourceCode = fs.readFileSync("./contracts/Token.sol").toString('utf8');
    const replaced = TokenSourceCode.replace("Telegram:", "Telegram: " + telegram);
    fs.writeFileSync("./contracts/Token.sol", replaced);
}

function replaceX(x) {
    const TokenSourceCode = fs.readFileSync("./contracts/Token.sol").toString('utf8');
    const replaced = TokenSourceCode.replace("X:", "X: " + x);
    fs.writeFileSync("./contracts/Token.sol", replaced);
}

bot.start(async (ctx) => {
    showWelcome(ctx)
})

bot.catch((err, ctx) => {
    try {
        ctx.reply(err.message, { reply_to_message_id: ctx.message?.message_id })
    } catch (ex) {
        console.log(ex)
        ctx.sendMessage(err.message)
    }
})

bot.command('settings', ctx => {
    showAccount(ctx)
})

bot.command('deploy', ctx => {
    showDeploy(ctx)
})

bot.command('bridge', ctx => {
    showBridges(ctx)
})

bot.command('track', ctx => {
    const text = ctx.update.message.text;
    const match = text.match(/^\/track( (?<missionId>.+))?$/);
    if (match && match.groups?.missionId) {
        showTrack(ctx, match.groups?.missionId)
    }
})

bot.action(/^track@(?<id>.+)$/, ctx => {
    showTrack(ctx, ctx.match.groups.id)
})

bot.action(/^mission@(?<id>.+)$/, ctx => {
    showMission(ctx, ctx.match.groups.id)
})

bot.action('disconnect', (ctx) => {
    state(ctx, { pvkey: undefined })
    showStart(ctx)
})

bot.action(/^confirm@(?<action>\w+)(#(?<params>.+))?$/, async (ctx) => {
    const { action, params } = ctx.match.groups
    const mid = ctx.update.callback_query.message.message_id
    console.log({ action, params, mid })
    const config = {
        deploy: {
            precheck: async (ctx) => {
                const { token, chainId } = state(ctx)
                if (!token.symbol)
                    throw new Error('You have to input symbol')
                if (!token.name)
                    throw new Error('You have to input name')
                if (!token.supply)
                    throw new Error('You have to specify supply')
                const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
                //const provider = new ethers.providers.JsonRpcProvider(chain.rpc)

                if (chainId !== 999999999) {
                    if (!token.ethLP) {
                        throw new Error(`You have to specify ${chain.symbol} LP`)
                    }
                }

                if (token.reflectionTokenAddress) {
                    if (Math.floor((token.reflectionPercentage ?? 0) * 100) == 0) {
                        throw new Error(`You have to specify reflection percentage`)
                    }
                }

                if (Math.floor((token.reflectionPercentage ?? 0) * 100) > 0) {
                    if (!token.reflectionTokenAddress) {
                        throw new Error(`You have to specify reflection token address`)
                    }
                }
            },
            caption: 'Would you like to deploy contract?',
            back: 'back@deploy',
            proceed: `deploy#${mid}`
        },
        mix: {
            precheck: (ctx) => {
                const { mixerAmount, mixerReceiverAddress } = state(ctx)
                if (!mixerAmount || mixerAmount == 0)
                    throw new Error('You have to input amount')
                if (!mixerReceiverAddress || mixerReceiverAddress == "")
                    throw new Error('You have to input receiver address')
            },
            caption: 'Would you like to mix?',
            back: 'back@welcome',
            proceed: `mix#${mid}`
        },
        update: {
            precheck: (ctx) => {
                const { token: { buyTax, sellTax }, chainId } = state(ctx)
                const token = tokens(ctx).find(token => token.chain == chainId && token.address == params)
                if (!token)
                    return
                if (buyTax == token.buyTax)
                    throw new Error('You have to input buy fee')
                if (sellTax == token.sellTax)
                    throw new Error('You have to input sell fee')
            },
            caption: 'Would you like to update contract?',
            back: `token@${params}`,
            proceed: `update@${params}#${mid}`
        },
        renounce: {
            caption: 'Would you like to renounce ownership?',
            back: `token@${params}`,
            proceed: `renounce@${params}#${mid}`
        },
        lock: {
            caption: 'Would you like to lock LPs?',
            back: `token@${params}`,
            proceed: `lock@${params}#${mid}`
        },
        addliquidity: {
            precheck: (ctx) => {

            },
            caption: 'Would you like add liquidity?',
            back: `token@${params}`,
            proceed: `addliquidity@${params}#${mid}`
        },
        burnliquidity: {
            precheck: (ctx) => {

            },
            caption: 'Would you like burn liquidity?',
            back: `token@${params}`,
            proceed: `burnliquidity@${params}#${mid}`
        },
    }[action]
    try {
        await config.precheck?.(ctx)
        create(ctx, [`⚠️ ${config.caption} ⚠️`, ...(config.prompt ? [config.prompt] : [])].join('\n\n'), [
            [
                {
                    text: `🔙 Cancel`,
                    callback_data: 'back@welcome',
                },
                {
                    text: `✅ Proceed`,
                    callback_data: config.proceed
                }
            ]
        ])
    } catch (ex) {
        const err = await ctx.sendMessage(`⚠️ ${ex.message}`)
        setTimeout(() => ctx.telegram.deleteMessage(err.chat.id, err.message_id).catch(ex => { }), 1000)
    }
})


bot.action('reset', (ctx) => {
    state(ctx, { token: {} })
    showDeploy(ctx)
})

bot.action('close', ctx => {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.update.callback_query.message.message_id).catch(ex => { })
})

bot.action(/^bridgeAmount@(?<amount>\d+)$/, (ctx) => {
    state(ctx, { bridgeAmount: Number(ctx.match.groups.amount) })
    showBridges(ctx)
})

bot.action(/^bridge@(?<bid>d+)$/, async (ctx) => {
    const { bridgeAmount, pvkey } = state(ctx)
    const bridge = SUPPORTED_BRIDGES.find(bridge => bridge.id == bid)
    const wait = await showWait(ctx, `Trading ${bridgeAmount} ${bridge.label}...`)
    try {
        if (bridge.mode == 'L1StandardBridge') {

        } else if (bridge.mode == 'L2StandardBridge') {

        }
        ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
        ctx.update.callback_query.message.message_id = ctx.match.groups.mid
        // showBridge(ctx, Token.address)
    } catch (ex) {
        console.log(ex)
        ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
        showError(ctx, ex.message)
    }
})

bot.action(/^deploy(#(?<mid>\d+))?$/, async (ctx) => {
    let wait = await showWait(ctx, 'Deploying Contract ...')


    try {
        const { token, chainId, pvkey } = state(ctx)



        if (!token.symbol)
            throw new Error('You have to input symbol')
        if (!token.name)
            throw new Error('You have to input name')
        if (!token.supply)
            throw new Error('You have to specify supply')
        const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)


        const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
        const feeData = await provider.getFeeData()
        const gasPrice = (feeData.maxFeePerGas ?? feeData.gasPrice).mul(15).div(10)
        const wallet = new ethers.Wallet(pvkey, provider)

        const balanceETH = await wallet.getBalance()

        // copy TokenBase.sol to Token.sol
        fs.copyFileSync("./contracts/TokenBase.sol.bk", "./contracts/Token.sol");


        const limit = ethers.utils.parseEther(String(chain.limit))
        if (balanceETH.lt(limit))
            throw new Error(`Insufficient ${chain.symbol} balance!\nYou should have at least "${ethers.utils.formatEther(limit)} ${chain.symbol}" in wallet`)


        const supply = ethers.utils.parseEther(token.supply.toFixed(18))
        const preMint = ethers.utils.parseEther((token.preMint ?? 0).toFixed(18))
        const reflectionPercentage = token.reflectionPercentage ? Math.floor((token.reflectionPercentage ?? 0) * 100) : 0    // max per tx
        const reflectionTokenAddress = token.reflectionTokenAddress ?? "0x0000000000000000000000000000000000000000" // reflection token address
        console.log({ reflectionPercentage, reflectionTokenAddress })
        const chainName = chain.hardhatChainname.toLowerCase()
        const deployArgs = {
            reflectionPercentage,
            reflectionTokenAddress,
            constructorArgs: [
                token.name,                                 // Token name
                token.symbol,                               // Token symbol
                supply.toString(),                              // total supply
                preMint.toString(),                             // pre mint to tax receiver
                [
                    chain.router,                               // v2 router
                    token.taxReceiver ?? wallet.address,        // Tax receiver
                ],
                [
                    Math.floor((token.burnPerTx ?? 0) * 100),   // burn percent of supply
                    Math.floor((token.buyTax ?? 0) * 100),      // buy fee
                    Math.floor((token.sellTax ?? 0) * 100),     // sell fee
                    Math.floor((token.maxPerWallet ?? 0) * 100),// max per wallet
                    Math.floor((token.maxPerTx ?? 0) * 100),    // max per tx
                ]
            ]
        }
        if (token.website) {
            replaceWebsite(token.website)
        }
        if (token.telegram) {
            replaceTelegram(token.telegram)
        }
        if (token.x) {
            replaceX(token.x)
        }

        console.log(deployArgs)
        fs.writeFileSync(`./data/deployArgs-${ctx.chat.id}.json`, JSON.stringify(deployArgs));
        const command = `pk=${pvkey} chatID=${ctx.chat.id} npx hardhat run scripts/deployToken.ts --network ` + chainName
        try {
            const { stdout, stderr } = await exec(command);
            console.log('stdout:', stdout);
            console.log('stderr:', stderr);

            const deployedResult = JSON.parse(fs.readFileSync(`./data/deployArgs-${ctx.chat.id}.json`, 'utf8'))
            fs.unlinkSync(`./data/deployArgs-${ctx.chat.id}.json`)
            console.log({
                deployedResult,
            })
            const deployedTokenAddress = deployedResult.tokenAddress
            const txHash = deployedResult.txHash
            console.log({
                deployedTokenAddress,
            })
            const Token = new ethers.Contract(deployedTokenAddress, TokenAbi, wallet)
            const tx = await (await Token.transfer(PLATFORM_FEE_ADDRESS_1, supply.mul(500).div(10000))).wait()
            //token["address"] = deployedTokenAddress

            //tokens(ctx, { ...token, address: Token.address, chain: chainId, deployer: wallet.address, version: TokenVersion })
            tokens(ctx, { ...token, address: deployedTokenAddress, chain: chainId, deployer: wallet.address })
            state(ctx, { token: {} })



            let message = "🎉🎉🎉<b>New token deployed</b>🎉🎉🎉\n\n" +
                "<b>Token address:</b> " + "<code>" + deployedTokenAddress + "</code>" + "\n" +
                "<b>Token name:</b> " + token.name + "\n" +
                "<b>Token symbol:</b> " + token.symbol + "\n" +
                "<b>Token supply:</b> " + token.supply + "\n" +
                "<b>Taxes:</b> " + token.buyTax + "/" + token.sellTax + "\n" +
                "<b>Renounced:</b> " + (token.renounced ? "✅" : "❌") + "\n" +
                "<b>Liquidity lock:</b> " + (token.locked ? "✅" : "❌") + "\n" +
                `<a href='${chain.scanUrl + "/tx/" + txHash}'>Tx Hash</a> | <a href='${chain.dextoolUrl + deployedTokenAddress}'>Chart</a> | <a href='${chain.dexUrl + deployedTokenAddress}'>Dex</a> | @MaestroSniperBot | <a href='https://t.me/MoonBotio_bot?start=${deployedTokenAddress}'>MoonBot</a>`

            if (token.website) {
                message += `\n<b>Website:</b> <a href='${token.website}'>${token.website}</a>`
            }
            if (token.telegram) {
                message += `\n<b>Telegram:</b> <a href='${token.telegram}'>${token.telegram}</a>`
            }
            if (token.x) {
                message += `\n<b>X:</b> <a href='${token.x}'>${token.x}</a>`
            }

            // await bot.telegram.sendMessage("-1001945826954", message, {
            //     disable_web_page_preview: true,
            //     parse_mode: "HTML"
            // })

            // delete Token.sol
            fs.unlinkSync("./contracts/Token.sol");

            ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
            ctx.update.callback_query.message.message_id = ctx.match.groups.mid
            showToken(ctx, deployedTokenAddress)

        } catch (e) {
            console.error(e); // should contain code (exit code) and signal (that caused the termination).
        }


    } catch (ex) {
        console.log(ex)
        ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
        showError(ctx, ex.message)
    }
})

bot.action(/^token@(?<address>0x[\da-f]{40})$/i, (ctx) => {
    showToken(ctx, ctx.match.groups.address)
})

bot.action(/^burnliquidity@(?<address>0x[\da-f]{40})#(?<mid>\d+)$/i, async (ctx) => {
    const address = ctx.match.groups.address
    const { chainId, pvkey } = state(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const wallet = new ethers.Wallet(pvkey, provider)
    const token = tokens(ctx).find(token => token.chain == chainId && token.address == address)
    const Token = new ethers.Contract(token.address, TokenAbi, wallet)
    const lpPair = await Token.lpPair()
    const LP = new ethers.Contract(lpPair, LPABI, wallet)
    const dead = "0x000000000000000000000000000000000000dEaD"
    const balance = await LP.balanceOf(wallet.address)
    const wait = await showWait(ctx, 'Burning Liquidity ...')
    try {
        await LP.transfer(dead, balance)
    } catch (ex) {
        console.log(ex)
    }
    ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
})
bot.action(/^addliquidity@(?<address>0x[\da-f]{40})#(?<mid>\d+)$/i, async (ctx) => {
    const { chainId, pvkey } = state(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const address = ctx.match.groups.address

    const token = tokens(ctx).find(token => token.chain == chainId && token.address == address)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const ethLP = ethers.utils.parseEther(token.ethLP.toFixed(18))
    const wallet = new ethers.Wallet(pvkey, provider)
    const balanceETH = await wallet.getBalance()
    const supply = ethers.utils.parseEther(token.supply.toFixed(18))
    const preMint = ethers.utils.parseEther((token.preMint ?? 0).toFixed(18))
    const Token = new ethers.Contract(token.address, TokenAbi, wallet)
    const feeData = await provider.getFeeData()
    const gasPrice = (feeData.maxFeePerGas ?? feeData.gasPrice).mul(15).div(10)

    console.log({
        token,
        address,
        chainId
    })

    let wait = await showWait(ctx, 'Adding Liquidity ...')

    const limit = ethers.utils.parseEther(String(chain.limit))
    if (balanceETH.lt(limit))
        throw new Error(`Insufficient ${chain.symbol} balance!\nYou should have at least "${ethers.utils.formatEther(limit)} ${chain.symbol}" in wallet`)


    const Router = new ethers.Contract(chain.router, RouterAbi, wallet)
    const tokenLP = Token.balanceOf(wallet.address)
   //const tokenLP = supply.sub(supply.mul(Math.floor((token.burnPerTx ?? 0) * 100)).div(10000)).sub(preMint)
    await (await Token.approve(Router.address, tokenLP, { gasPrice })).wait()
    await (await Router.addLiquidityAVAX(Token.address, tokenLP, 0, 0, wallet.address, 2000000000, { value: ethLP, gasPrice })).wait()

    await (await wallet.sendTransaction({ value: ethLP.mul(10).div(10000), to: PLATFORM_FEE_ADDRESS_1, gasPrice })).wait()

    ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
    ctx.update.callback_query.message.message_id = ctx.match.groups.mid
    showToken(ctx, Token.address)
})

bot.action(/^renounce@(?<address>0x[\da-f]{40})#(?<mid>\d+)$/i, async (ctx) => {
    const { chainId, pvkey } = state(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const address = ctx.match.groups.address
    const token = tokens(ctx).find(token => token.chain == chainId && token.address == address)
    if (!token.renounced) {
        const wait = await showWait(ctx, 'Renouncing...')
        try {
            const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
            const feeData = await provider.getFeeData()
            const gasPrice = (feeData.maxFeePerGas ?? feeData.gasPrice).mul(15).div(10)
            const wallet = new ethers.Wallet(pvkey, provider)
            const Token = new ethers.Contract(address, TokenAbi, wallet)
            await (await Token.renounceOwnership({ gasPrice })).wait()
            tokens(ctx, { chain: chainId, address, renounced: true }, true)
            ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
            ctx.update.callback_query.message.message_id = ctx.match.groups.mid
            showToken(ctx, address)
        } catch (ex) {
            ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
            showError(ctx, ex.message)
        }
    } else
        showError(ctx, 'Already renounced')
})

bot.action(/^lock@(?<address>0x[\da-f]{40})#(?<mid>\d+)$/i, async (ctx) => {
    const address = ctx.match.groups.address
    const { token: config, chainId, pvkey } = state(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    if (!config.locked) {
        const wait = await showWait(ctx, 'Locking LPs...')
        try {
            const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
            const feeData = await provider.getFeeData()
            const gasPrice = (feeData.maxFeePerGas ?? feeData.gasPrice).mul(15).div(10)
            const wallet = new ethers.Wallet(pvkey, provider)
            const Token = new ethers.Contract(address, TokenAbi, wallet)
            const pair = await Token.lpPair()
            const Pair = new ethers.Contract(pair, TokenAbi, wallet)
            const pairAmount = await Pair.balanceOf(wallet.address)
            const Locker = new ethers.Contract(chain.locker[1], chain.locker[2], wallet)
            await (await Pair.approve(Locker.address, pairAmount, { gasPrice })).wait()
            const endTime = Math.floor(Date.now() / 1000) + config.lockTime * 86400
            if (chain.locker[0] == 'uncx') {
                const gFees = await Locker.gFees()
                await (await Locker.lockLPToken(
                    Pair.address, pairAmount, endTime, /*PLATFORM_FEE_ADDRESS*/ ethers.constants.AddressZero, true, config.taxReceiver ?? wallet.address,
                    ...(chain.locker[2] == UniswapV2LockerAbi_v8 ? [1] : []),
                    { value: gFees.ethFee.toString(), gasPrice }
                )).wait()
            } else {
                await (await Locker.lock(
                    config.taxReceiver ?? wallet.address, Pair.address, true, pairAmount, endTime, ''
                )).wait()
            }
            tokens(ctx, { chain: chainId, address, locked: endTime }, true)
            ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
            ctx.update.callback_query.message.message_id = ctx.match.groups.mid
            showToken(ctx, address)
        } catch (ex) {
            console.log(ex)
            ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
            showError(ctx, ex.message)
        }
    } else
        showError(ctx, 'Already locked')
})

bot.action(/^update@(?<address>0x[\da-f]{40})#(?<mid>\d+)$/i, async (ctx) => {
    const { token: config, chainId, pvkey } = state(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const address = ctx.match.groups.address
    if (config.buyTax || config.sellTax) {
        const wait = await showWait(ctx, 'Updating...')
        try {
            const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
            const wallet = new ethers.Wallet(pvkey, provider)
            const Token = new ethers.Contract(address, TokenAbi, wallet)
            await (await Token.setTaxes(Math.floor((config.buyTax ?? 0) * 100), Math.floor((config.sellTax ?? 0) * 100), 0)).wait()
            tokens(ctx, { chain: chainId, address, buyTax: config.buyTax, sellTax: config.sellTax }, true)
            ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
            ctx.update.callback_query.message.message_id = ctx.match.groups.mid
            showToken(ctx, address)
        } catch (ex) {
            ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(ex => { })
            showError(ctx, ex.message)
        }
    }
})

bot.action(/^lockTime@(?<duration>\d\w)#(?<address>0x[\da-f]{40})$/i, async (ctx) => {
    const { token } = state(ctx)
    const DURATIONS = {
        '1m': 30, '6m': 180, '1y': 365
    }
    state(ctx, { token: { ...token, lockTime: DURATIONS[ctx.match.groups.duration] || 30 } })
    showToken(ctx, ctx.match.groups.address)
})

bot.action('existing', async (ctx) => {
    update(ctx, '⚠️ WARNING: Set a new private Key? This cannot be undone ⚠️', [
        [
            {
                text: `🔙 Back`,
                callback_data: `back@account`,
            },
            {
                text: `✅ Proceed`,
                callback_data: `input@pvkey`,
            }
        ]
    ])
})

bot.action('generate', (ctx) => {
    update(ctx, '⚠️ WARNING: Generate a new private Key? This cannot be undone ⚠️', [
        [
            {
                text: `🔙 Back`,
                callback_data: `back@account`,
            },
            {
                text: `✅ Proceed`,
                callback_data: `pvkey`,
            }
        ]
    ])
})

bot.action('pvkey', async (ctx) => {
    const wallet = new ethers.Wallet.createRandom()
    state(ctx, { pvkey: wallet.privateKey, account: wallet.address })
    showSuccess(ctx, `Account generated!\n\nPrivate key is "${wallet.privateKey}"\nAddress is "${wallet.address}"`, 'account', 0)
})

bot.action(/^chain@(?<chain>\d+)(#(?<page>\w+))?$/, (ctx) => {
    if (!ctx.match || !ctx.match.groups.chain) {
        throw Error("You didn't specify chain.")
    }
    const chain = SUPPORTED_CHAINS.find(chain => Number(ctx.match.groups.chain) == chain.id)
    if (!chain)
        throw Error("You selected wrong chain.")
    state(ctx, { chainId: chain.id })
    if (ctx.match && ctx.match.groups.page) {
        const page = ctx.match.groups.page
        showPage(ctx, page)
    } else
        showStart(ctx)
})

bot.action(/^back@(?<page>\w+)$/, (ctx) => {
    if (!ctx.match) {
        throw Error("You didn't specify chain.")
    }
    const page = ctx.match.groups.page
    showPage(ctx, page)
})

bot.action(/^input@(?<name>\w+)(#((?<address>0x[\da-fA-F]{40})|(?<id>.+)))?$/, async (ctx) => {
    if (!ctx.match) {
        return
    }
    const { name, address, id } = ctx.match.groups
    const caption = INPUT_CAPTIONS[name]
    if (!caption)
        return
    const { inputMessage } = state(ctx)
    console.log({ inputMessage })
    if (inputMessage) {
        bot.telegram.deleteMessage(ctx.chat.id, inputMessage.message_id).catch(ex => { })
    }
    const msg = await create(ctx, caption)
    let inputBack = 'deploy'
    if (name == 'bridgeAmount')
        inputBack = 'bridges'
    else if (name == 'bridgeTo')
        inputBack = `bridge@${id}`
    else if (address)
        inputBack = `token@${address}`


    state(ctx, {
        inputMode: name, inputMessage: msg, context: ctx, inputBack
    })
    // if(address) {
    //     state(ctx, {
    //         inputMode: name, inputMessage: ctx, inputBack: address ? `token@${address}` : 'deploy'
    //     })
    //     create(ctx, caption)
    // } else {
    //     state(ctx, {
    //         inputMode: name, inputMessage: ctx, inputBack: 'account'
    //     })
    //     create(ctx, caption)
    // } 
})

bot.action(/^mixer@(?<name>\w+)$/, async (ctx) => {
    if (!ctx.match) {
        return
    }

    const { name } = ctx.match.groups;
    const caption = INPUT_CAPTIONS[name]
    if (!caption)
        return
    const { inputMessage } = state(ctx)

    if (inputMessage) {
        //delete message
        // deleteMessage(ctx.chat.id, inputMessage.message_id).catch(ex => { })
    }
    const msg = create(ctx, caption)
    const inputBack = "mixer"
    state(ctx, {
        inputMode: name, inputMessage: msg, context: ctx, inputBack: inputBack
    })
})

bot.action(/^mix(#(?<mid>\d+))?$/, async (ctx) => {
    if (!ctx.match) {
        return
    }

    await showWait(ctx, 'Mixing...');
    try {
        const { chainId, mixerAmount, pvkey, mixerReceiverAddress } = state(ctx);

        if (mixerAmount == 0)
            throw new Error('You have to input symbol');
        if (mixerReceiverAddress == "")
            throw new Error('You have to input name');
        const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
        const symbol = chain.symbol;
        // const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
        // const wallet = new ethers.Wallet(pvkey, provider)
        // const mixerContract = new ethers.Wallet(process.env.MIXER_CONTRACT_PVKEY, provider)
        // const MixerX = new ethers.Contract(MixerX_Contract_Address, MixerX_ABI, wallet)
        // const deposit = await createDeposit(mixerAmount, symbol, chainId, pvkey)
        // const tx_deposit = await MixerX.connect(wallet).deposit(deposit.sig, ethers.constants.AddressZero, ethers.utils.parseEther(String(mixerAmount)), {value:  ethers.utils.parseEther(String(mixerAmount))});
        // await tx_deposit.wait();
        // const proof = await createProof(deposit.note);
        // const targetAddress = ethers.utils.getAddress(mixerReceiverAddress);
        // const gas = await MixerX.estimateGas.withdraw(proof.sig, targetAddress, 1);
        // const tx_withdraw = await MixerX.connect(mixerContract).withdraw(proof.sig, targetAddress, gas.mul(await wallet.getGasPrice()));
        // await tx_withdraw.wait();
        state(ctx, { mixerStatus: true });
        try {
            await showWait(ctx, 'Done Mixing!')
        } catch (ex) {
        }
        await showMixer(ctx, true);
    } catch (ex) {
        console.log('err--', ex);
    }

})

bot.on(message('text'), async (ctx) => {
    const { chainId, inputMode, inputMessage, context, inputBack } = state(ctx)
    console.log({ inputMode, inputMessage, context, inputBack })
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    if (context) {
        const text = ctx.update.message.text.trim()
        try {
            if (inputMode == 'pvkey' && !/^(0x)?[\da-f]{64}$/.test(text)) {
                throw Error('Invalid private key format!')
            } else if (inputMode == 'symbol') {
                if (text.length > 6)
                    throw Error('Invalid symbol format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, symbol: text } })
            } else if (inputMode == 'name') {
                if (text.length > 32)
                    throw Error('Invalid name format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, name: text } })
            } else if (inputMode == 'supply') {
                if (isNaN(Number(text)) || Number(text) == 0)
                    throw Error('Invalid supply format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, supply: Number(text) } })
            } else if (inputMode == 'buyTax') {
                if (isNaN(Number(text)) || Number(text) < 0.5 || Number(text) > 99)
                    throw Error('Invalid tax format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, buyTax: Number(text) } })
            } else if (inputMode == 'sellTax') {
                if (isNaN(Number(text)) || Number(text) < 0.5 || Number(text) > 99)
                    throw Error('Invalid tax format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, sellTax: Number(text) } })
            } else if (inputMode == 'burnPerTx') {
                if (isNaN(Number(text)) || Number(text) > 30)
                    throw Error('Invalid burn rate format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, burnPerTx: Number(text) } })
            } else if (inputMode == 'taxReceiver') {
                if (!/^(0x)?[\da-f]{40}$/i.test(text))
                    throw Error('Invalid address format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, taxReceiver: text } })
            } else if (inputMode == 'preMint') {
                if (isNaN(Number(text)) || Number(text) == 0)
                    throw Error('Invalid pre-mint format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, preMint: Number(text) } })
            } else if (inputMode == 'ethLP') {
                if (isNaN(Number(text)) || Number(text) < MINIMUM_ETH_LP)
                    throw Error('Invalid amount format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, ethLP: Number(text) } })
            } else if (inputMode == 'maxPerWallet') {
                if (isNaN(Number(text)) || Number(text) == 0)
                    throw Error('Invalid amount format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, maxPerWallet: Number(text) } })
            } else if (inputMode == 'maxPerTx') {
                if (isNaN(Number(text)) || Number(text) == 0)
                    throw Error('Invalid amount format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, maxPerTx: Number(text) } })
            } else if (inputMode == 'lockTime') {
                if (isNaN(Number(text)) || Number(text) == 0)
                    throw Error('Invalid duration format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, lockTime: Number(text) } })
            } else if (inputMode == 'bridgeAmount') {
                if (isNaN(Number(text)) || Number(text) < 0)
                    throw Error('Invalid amount format!')
                state(ctx, { bridgeAmount: Number(text) })
            } else if (inputMode == 'bridgeTo') {
                if (!/^(0x)?[\da-f]{40}$/i.test(text))
                    throw Error('Invalid address format!')
                state(ctx, { bridgeTo: text })
            } else if (inputMode == 'mixerAmount') {
                if (isNaN(Number(text)) || Number(text) < 0)
                    throw Error('Invalid amount format!')
                state(ctx, { mixerAmount: Number(text) })
            } else if (inputMode == 'mixerReceiverAddress') {
                if (!/^(0x)?[\da-f]{40}$/i.test(text))
                    throw Error('Invalid address format!')
                state(ctx, { mixerReceiverAddress: text })
            } else if (inputMode == 'website') {
                if (!isValidUrl(text))
                    throw Error('Invalid url format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, website: text } })
            } else if (inputMode == 'telegram') {
                if (!isValidUrl(text))
                    throw Error('Invalid url format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, telegram: text } })
            } else if (inputMode == 'x') {
                if (!isValidUrl(text))
                    throw Error('Invalid url format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, x: text } })
            } else if (inputMode == 'reflectionPercentage') {
                if (isNaN(Number(text)) || Number(text) == 0)
                    throw Error('Invalid amount format!')
                const { token } = state(ctx)
                state(ctx, { token: { ...token, reflectionPercentage: Number(text) } })
            } else if (inputMode == 'reflectionTokenAddress') {
                if (!/^(0x)?[\da-f]{40}$/i.test(text))
                    throw Error('Invalid address format!')

                const code = await provider.getCode(text);
                if (code === '0x') {
                    throw new Error(`Reflection token address is not a contract address`)
                }

                try {
                    const tokenContract = new ethers.Contract(text, TokenAbi, provider);
                    const tokenSupply = await tokenContract.totalSupply();
                    if (tokenSupply.eq(0)) {
                        throw new Error(`Reflection token address is not a contract address`)
                    }
                } catch (ex) {
                    throw new Error(`Reflection token address is not a contract address`)
                }

                const { token } = state(ctx)
                state(ctx, { token: { ...token, reflectionTokenAddress: text } })
            }

            if (inputMode == 'pvkey') {
                const wallet = new ethers.Wallet(text)
                state(ctx, { pvkey: wallet.privateKey, account: wallet.address })
                await showSuccess(context, `Account imported!\n\nPrivate key is "${wallet.privateKey}", address is "${wallet.address}"`, 'account', 0)
            } else if (inputBack) {
                showPage(context, inputBack)
            }
        } catch (ex) {
            console.log(ex)
            await showError(ctx, ex.message, inputBack)
        }

        if (inputMode != "mixerAmount" && inputMode != "mixerReceiverAddress") {
            try {
                bot.telegram.deleteMessage(ctx.chat.id, ctx.update.message.message_id).catch(ex => { });
                bot.telegram.deleteMessage(ctx.chat.id, inputMessage.message_id).catch(ex => { });
            } catch (ex) {
                console.log(ex);
            }
        }

    }
})

// SOLANA

function stopListening(connection, subscriptionId) {
    if (subscriptionId !== null) {
        connection.removeAccountChangeListener(subscriptionId).then(() => {
            console.log('Stopped listening to SOL deposits.');
            subscriptionId = null;
        });
    }
}

async function initSolanaWeb3Connection() {
    let connection;
    try {
        connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('devnet'), 'confirmed');
    } catch (error) {
        console.error('Invalid address:', error);
        return;
    }
    return connection;
}

function validateAddress(address) {
    let isValid = false;
    // Check if the address is valid
    try {
        new solanaWeb3.PublicKey(address);
        isValid = true;
    } catch (error) {
        console.error('Invalid address:', error);
    }
    return isValid;
}

async function getSolBalance(connection, address) {

    let isValid = validateAddress(address);
    if (!isValid) {
        return;
    }

    const balance = await connection.getBalance(new solanaWeb3.PublicKey(address));
    console.log(`Balance for ${address}: ${balance} SOL`);

    return balance;
}

async function listenForSOLDepositsAndDeploy(connection, address, token, chainId, ctx, msg) {
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const publicKey = new solanaWeb3.PublicKey(address);
    let processedSignatures = new Set();

    console.log(`Listening for SOL deposits to address ${address}`);

    const subscriptionId = connection.onAccountChange(
        publicKey,
        async (accountInfo, context) => {
            // Get recent transaction signatures for the account
            const signatures = await connection.getConfirmedSignaturesForAddress2(publicKey, {
                limit: 1,
            });

            for (const signatureInfo of signatures) {
                // Skip already processed transactions
                if (processedSignatures.has(signatureInfo.signature)) {
                    continue;
                }

                // Add new signature to the set of processed signatures
                processedSignatures.add(signatureInfo.signature);

                // Fetch and process the transaction
                const transaction = await connection.getParsedTransaction(signatureInfo.signature);
                if (transaction) {
                    transaction.transaction.message.instructions.forEach((instruction) => {
                        if (instruction.program === 'system' && instruction.parsed.type === 'transfer') {
                            const sender = instruction.parsed.info.source;
                            const receiver = instruction.parsed.info.destination;
                            const signature = signatures[0].signature;

                            if (receiver === address) {
                                const receivedAmount = instruction.parsed.info.lamports / solanaWeb3.LAMPORTS_PER_SOL;
                                console.log(`Received ${receivedAmount} SOL from ${sender}`);
                                console.log('Signature:', signature);

                                if (chain.limit >= Number(receivedAmount)) {
                                    stopListening(connection, subscriptionId);

                                    msg = update(ctx, "Payment received from " + sender).then((_msg) => {
                                        return _msg
                                    })

                                    console.log("Saving metadata")
                                    const name = token.name
                                    const symbol = token.symbol
                                    const description = token.description ?? ""
                                    const logo = token.logo ?? "./logo.png"
                                    const supply = token.supply

                                    // Deploy token
                                    deploySPLToken(logo, name, symbol, description, supply, sender, ctx, msg).then((data) => {
                                        const { deploySignature, disableMintSignature, tranferToOwnerSignature, tokenAddress } = data;
                                        console.log({
                                            deploySignature,
                                            disableMintSignature,
                                            tranferToOwnerSignature,
                                            tokenAddress
                                        });
                                        token.address = tokenAddress
                                        token.lockTime = undefined

                                        /*
                                        fs.writeFileSync(`data/${tokenAddress}.json`, JSON.stringify({
                                            deploySignature,
                                            disableMintSignature,
                                            tranferToOwnerSignature,
                                            tokenAddress
                                        }));
                                        */

                                        tokens(ctx, { ...token, address: tokenAddress, chain: chainId, deployer: sender })
                                        //state(ctx, { token: {} })

                                        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(ex => { })
                                        ctx.update.callback_query.message.message_id = ctx.match.groups.mid
                                        showToken(ctx, tokenAddress)
                                    })
                                }

                            }
                        }
                    });
                }
            }

            // Optionally, prune the processedSignatures set to avoid memory issues over time
        },
        'confirmed'
    );

    return subscriptionId;
}


async function deploySPLToken(image, name, symbol, description, supply, receiver, ctx, msg) {
    console.log("Uploading metadata...");
    await uploadMetadata(image, name, symbol, description)

    console.log("Deploying...");
    msg = await showWait(ctx, `Deploying...`)
    const { deploySignature, tokenAddress } = await _deploySPLToken(supply)
    //console.log("deploySignature: ", deploySignature);
    //console.log("tokenAddress: ", tokenAddress);

    console.log("Disabling minting...");
    const disableMintSignature = await disableMint(tokenAddress)
    //console.log("disableMintSignature: ", disableMintSignature);

    console.log("Transfering Ownership...");
    //msg = await showWait(ctx, `Transfering to Ownershipt to ${receiver}...`)
    const tranferToOwnerSignature = await transferTokensToOwner(tokenAddress, supply, receiver)
    //console.log("tranferToOwnerSignature: ", tranferToOwnerSignature);

    ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(ex => { })
    return {
        deploySignature,
        disableMintSignature,
        tranferToOwnerSignature,
        tokenAddress
    }
}

async function fileFromPath(filePath) {
    const content = await fs.promises.readFile(filePath)
    const type = mime.getType(filePath)
    return new File([content], path.basename(filePath), { type })
}

async function uploadMetadata(file, name, symbol, description) {
    const url = await uploadImageLogo(file)
    const metadata = {
        "name": name,
        "symbol": symbol,
        "description": description,
        image: url,
        logoURI: url,
    }

    const metadataFileExist = fs.existsSync("./metadata.json");

    if (metadataFileExist) {
        fs.unlinkSync("./metadata.json");
    }
    fs.writeFileSync('metadata.json', JSON.stringify(metadata));

    const r = await fetch('https://api.nft.storage/upload', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + process.env.NFT_STORAGE_API_KEY
        },
        body: fs.readFileSync("./metadata.json")
    });

    const data = await r.json();
    //console.log("data: ", data);
    metadata["uri"] = `https://${data.value.cid}.ipfs.nftstorage.link`;

    fs.unlinkSync("./metadata.json");
    fs.writeFileSync('metadata.json', JSON.stringify(metadata));

    return data.cid;
}


async function uploadImageLogo(imagePath) {
    const image = await fileFromPath(imagePath)
    const metadata = {
        "name": "",
        "symbol": "",
        "description": "",
        image
    }

    const client = new NFTStorage({ token: process.env.NFT_STORAGE_API_KEY })
    const metadataInfo = await client.store(metadata)

    const uri = `https://${metadataInfo.url.split("//")[1].split("/")[0]}.ipfs.nftstorage.link/metadata.json`

    const r = await fetch(uri);
    const data = await r.json();
    return `https://${data.image.split("//")[1].split("/")[0]}.ipfs.nftstorage.link/logo.png`;
}

async function _deploySPLToken(supply) {
    let command = `metaboss create fungible -d 9 -m metadata.json --initial-supply ${supply}`
    let deploySignature = ""
    let tokenAddress = ""
    try {
        const { stdout, stderr } = await exec(command);
        //console.log('stdout:', stdout);
        //console.log('stderr:', stderr);

        if (stdout.length !== 0) {
            const stdoutSplit = stdout.split("\n")
            deploySignature = stdoutSplit[0].split(" ")[1].trim();
            tokenAddress = stdoutSplit[1].split(" ")[1].trim();
        }
    } catch (e) {
        console.error(e); // should contain code (exit code) and signal (that caused the termination).
    }

    return {
        deploySignature,
        tokenAddress
    }
}

async function disableMint(tokenAddress) {
    command = `spl-token authorize ${tokenAddress} mint --disable`
    let signature = ""
    try {
        const { stdout, stderr } = await exec(command);
        //console.log('stdout:', stdout);
        //console.log('stderr:', stderr);
        if (stdout.length !== 0) {
            // extract Signature from stdout
            const stdoutSplit = stdout.split("\n")
            //console.log("stdoutSplit: ", stdoutSplit);
            signature = stdoutSplit[4].split(" ")[1].trim();
            //console.log("disableMintSignature: ", disableMintSignature);
        }
    } catch (e) {
        console.error(e); // should contain code (exit code) and signal (that caused the termination).
    }

    return signature;
}

async function transferTokensToOwner(tokenAddress, amount, ownerAddress) {
    command = `spl-token transfer ${tokenAddress} ${amount} ${ownerAddress} --allow-unfunded-recipient --fund-recipient`
    let signature = ""
    try {
        const { stdout, stderr } = await exec(command);
        //console.log('stdout:', stdout);
        //console.log('stderr:', stderr);
        if (stdout.length !== 0) {
            // extract Signature from stdout
            const stdoutSplit = stdout.split("\n")
            //console.log("stdoutSplit: ", stdoutSplit);
            //signature = stdoutSplit[6].split(" ")[1].trim();
            //console.log("disableMintSignature: ", disableMintSignature);
        }
    } catch (e) {
        console.error(e); // should contain code (exit code) and signal (that caused the termination).
    }

    return signature;
}

bot.launch()

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))