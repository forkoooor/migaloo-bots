export interface Overseer {
	overseerAddress: string;
}

export interface AnchorOverseer extends Overseer {
	oracleAddress: string;
	marketAddress: string;
	liquidatorAddress: string;
	priceFeeders?: Array<string>;
	priceFeed: Map<string, number>;
	whitelist: AnchorWhitelist;
}

export interface AnchorWhitelist {
	elems: Array<AnchorWhitelistElement>;
}

interface AnchorWhitelistElement {
	name: string;
	symbol: string;
	max_ltv: string;
	custody_contract: string;
	collateral_token: string;
}

export type Loans = Array<Loan>;

export interface Loan {
	borrowerAddress: string;
	collaterals?: { [address: string]: number | undefined };
	borrowLimit?: number | undefined;
	riskRatio?: number | undefined;
	loanAmt?: number | undefined;
}

export interface PriceFeed {
	[tokenaddrs: string]: { price: number; custodyAddrs: string; ltv: number };
}
