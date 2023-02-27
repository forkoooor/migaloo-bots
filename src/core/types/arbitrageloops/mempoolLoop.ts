import { AccountData } from "@cosmjs/amino";
import { EncodeObject } from "@cosmjs/proto-signing";
import { createJsonRpcRequest } from "@cosmjs/tendermint-rpc/build/jsonrpc";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import { OptimalTrade } from "../../arbitrage/arbitrage";
import { Logger } from "../../logging";
import { BotClients } from "../../node/chainoperator";
import { BotConfig } from "../base/botConfig";
import { LogType } from "../base/logging";
import { flushTxMemory, Mempool, MempoolTrade, processMempool } from "../base/mempool";
import { Path } from "../base/path";
import { applyMempoolTradesOnPools, Pool } from "../base/pool";

/**
 *
 */
export class MempoolLoop {
	pools: Array<Pool>;
	paths: Array<Path>;
	CDpaths: Array<{ path: Path; num: number }>;
	botClients: BotClients;
	account: AccountData;
	accountNumber = 0;
	sequence = 0;
	chainid = "";
	botConfig: BotConfig;
	logger: Logger | undefined;
	// CACHE VALUES
	totalBytes = 0;
	mempool!: Mempool;
	iterations = 0;

	/**
	 *
	 */
	arbitrageFunction: (paths: Array<Path>, botConfig: BotConfig) => OptimalTrade | undefined;
	updateStateFunction: (botClients: BotClients, pools: Array<Pool>) => void;
	messageFunction: (
		arbTrade: OptimalTrade,
		walletAddress: string,
		flashloancontract: string,
	) => [Array<EncodeObject>, number];

	/**
	 *
	 */
	public constructor(
		pools: Array<Pool>,
		paths: Array<Path>,
		arbitrage: (paths: Array<Path>, botConfig: BotConfig) => OptimalTrade | undefined,
		updateState: (botclients: BotClients, pools: Array<Pool>) => void,
		messageFunction: (
			arbTrade: OptimalTrade,
			walletAddress: string,
			flashloancontract: string,
		) => [Array<EncodeObject>, number],
		botClients: BotClients,
		account: AccountData,
		botConfig: BotConfig,
		logger: Logger | undefined,
	) {
		this.pools = pools;
		this.CDpaths = new Array<{ path: Path; num: number }>();
		this.paths = paths;
		this.arbitrageFunction = arbitrage;
		this.updateStateFunction = updateState;
		this.messageFunction = messageFunction;
		this.botClients = botClients;
		this.account = account;
		this.botConfig = botConfig;
		this.logger = logger;
	}

	/**
	 *
	 */
	public async fetchRequiredChainData() {
		const { accountNumber, sequence } = await this.botClients.SigningCWClient.getSequence(this.account.address);
		this.sequence = sequence;
		this.accountNumber = accountNumber;

		const chainId = await this.botClients.SigningCWClient.getChainId();
		this.chainid = chainId;
	}

	/**
	 *
	 */
	public async step() {
		this.iterations++;
		this.updateStateFunction(this.botClients, this.pools);

		const arbTrade: OptimalTrade | undefined = this.arbitrageFunction(this.paths, this.botConfig);

		if (arbTrade) {
			await this.trade(arbTrade);
			//arbTrade.path.cooldown = true;
			this.cdPaths(arbTrade.path);
			return;
		}

		while (true) {
			const mempoolResult = await this.botClients.HttpClient.execute(createJsonRpcRequest("unconfirmed_txs"));
			this.mempool = mempoolResult.result;

			if (+this.mempool.total_bytes < this.totalBytes) {
				break;
			} else if (+this.mempool.total_bytes === this.totalBytes) {
				continue;
			} else {
				this.totalBytes = +this.mempool.total_bytes;
			}

			const mempoolTrades: Array<MempoolTrade> = processMempool(this.mempool);
			if (mempoolTrades.length === 0) {
				continue;
			} else {
				applyMempoolTradesOnPools(this.pools, mempoolTrades);
			}

			const arbTrade = this.arbitrageFunction(this.paths, this.botConfig);

			if (arbTrade) {
				await this.trade(arbTrade);
				//arbTrade.path.cooldown = true;
				this.cdPaths(arbTrade.path);
				break;
			}
		}
	}

	/**
	 *
	 */
	public reset() {
		// reset all paths that are on cooldown
		//this.paths.forEach((path) => {
		//	path.cooldown = false;
		//});
		this.unCDPaths();
		this.totalBytes = 0;
		flushTxMemory();
	}

	/**
	 *
	 */
	private async trade(arbTrade: OptimalTrade) {
		//if (arbTrade.path.cooldown) {
		//	return;
		//}
		const [msgs, nrOfMessages] = this.messageFunction(
			arbTrade,
			this.account.address,
			this.botConfig.flashloanRouterAddress,
		);

		await this.logger?.sendMessage(JSON.stringify(msgs), LogType.Console);

		const signerData = {
			accountNumber: this.accountNumber,
			sequence: this.sequence,
			chainId: this.chainid,
		};

		const TX_FEE =
			this.botConfig.txFees.get(nrOfMessages) ??
			Array.from(this.botConfig.txFees.values())[this.botConfig.txFees.size - 1];

		// sign, encode and broadcast the transaction
		const txRaw = await this.botClients.SigningCWClient.sign(
			this.account.address,
			msgs,
			TX_FEE,
			"memo",
			signerData,
		);
		const txBytes = TxRaw.encode(txRaw).finish();
		const sendResult = await this.botClients.TMClient.broadcastTxSync({ tx: txBytes });

		await this.logger?.sendMessage(JSON.stringify(sendResult), LogType.Console);

		this.sequence += 1;
		await delay(5000);
		await this.fetchRequiredChainData();
	}
	/**
	 * Put path on Cooldown, add to CDPaths with iteration number as block.
	 * Updates this.Path. More than half (0.5) of pool addrss should be different. 
	 */
	public cdPaths(path: Path) {
		const tmp = this.getAddrfromPath(path);
		const out = new Array<Path>();
		for (let i = 0; i < this.paths.length; i++) {
			const addset = this.getAddrfromPath(this.paths[i]);
			const symdiff = this.symmetricDifference(addset, tmp);
			if (symdiff.size <= (addset.size + tmp.size) * 0.5) {
				this.CDpaths.push({ path: this.paths[i], num: this.iterations });
			} else {
				out.push(this.paths[i]);
			}
		}
		this.paths = out;
	}

	/**
	 *
	 * Updates the CD Paths if path.num + Cooldownblocks <= this.iterations
	 * ADDS to this.paths.
	 */
	public unCDPaths() {
		const COOLDOWNBLOCKS = 20;
		const tmp = this.CDpaths;
		//prevent Loops if the first item isnt ready yet

		if (tmp[0] && tmp[0].num + COOLDOWNBLOCKS <= this.iterations) {
			// Get Paths to clear of CD
			const clearpaths = this.CDpaths.filter((c) => c.num + COOLDOWNBLOCKS <= this.iterations);
			// Delete from CDs
			this.CDpaths = tmp.filter((n) => !clearpaths.includes(n));
			//Add Cooldowned Paths back to active Paths
			clearpaths.forEach((n) => this.paths.push(n.path));
		}
	}

	/**
	 * Returns Set of Addresses in Path.
	 */
	private getAddrfromPath(path: Path) {
		const out = new Set<string>();
		for (let i = 0; i < path.pools.length; i++) {
			out.add(path.pools[i].address);
		}
		return out;
	}

	/**
	 * SymmetricDifference of 2 Address Sets.
	 */
	private symmetricDifference(setA: Set<string>, setB: Set<string>) {
		const _difference = new Set(setA);
		for (const elem of setB) {
			if (_difference.has(elem)) {
				_difference.delete(elem);
			} else {
				_difference.add(elem);
			}
		}
		return _difference;
	}
}

/**
 *
 */
function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
