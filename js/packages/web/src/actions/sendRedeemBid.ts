import {
  Keypair,
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  actions,
  ParsedAccount,
  programIds,
  models,
  TokenAccount,
  createMint,
  SafetyDepositBox,
  cache,
  ensureWrappedAccount,
  updatePrimarySaleHappenedViaToken,
  getMetadata,
  deprecatedGetReservationList,
  AuctionState,
  sendTransactionsWithManualRetry,
  MasterEditionV1,
  MasterEditionV2,
  findProgramAddress,
  createAssociatedTokenAccountInstruction,
  deprecatedMintNewEditionFromMasterEditionViaPrintingToken,
  MetadataKey,
  getEdition,
} from '@oyster/common';

import { AccountLayout, MintLayout, Token } from '@solana/spl-token';
import { AuctionView, AuctionViewItem } from '../hooks';
import {
  WinningConfigType,
  NonWinningConstraint,
  redeemBid,
  redeemFullRightsTransferBid,
  deprecatedRedeemParticipationBid,
  redeemParticipationBidV2,
  WinningConstraint,
  WinningConfigItem,
  WinningConfigStateItem,
  redeemPrintingV2Bid,
  PrizeTrackingTicket,
  getPrizeTrackingTicket,
} from '../models/metaplex';
import { claimBid } from '../models/metaplex/claimBid';
import { setupCancelBid } from './cancelBid';
import { deprecatedPopulateParticipationPrintingAccount } from '../models/metaplex/deprecatedPopulateParticipationPrintingAccount';
import { setupPlaceBid } from './sendPlaceBid';
import { claimUnusedPrizes } from './claimUnusedPrizes';
import { BN } from 'bn.js';
const { createTokenAccount } = actions;
const { approve } = models;

export function eligibleForParticipationPrizeGivenWinningIndex(
  winnerIndex: number | null,
  auctionView: AuctionView,
) {
  return (
    (winnerIndex === null &&
      auctionView.auctionManager.info.settings.participationConfig
        ?.nonWinningConstraint !== NonWinningConstraint.NoParticipationPrize) ||
    (winnerIndex !== null &&
      auctionView.auctionManager.info.settings.participationConfig
        ?.winnerConstraint !== WinningConstraint.NoParticipationPrize)
  );
}

export async function sendRedeemBid(
  connection: Connection,
  wallet: any,
  payingAccount: PublicKey,
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  prizeTrackingTickets: Record<string, ParsedAccount<PrizeTrackingTicket>>,
) {
  let signers: Array<Keypair[]> = [];
  let instructions: Array<TransactionInstruction[]> = [];

  if (
    auctionView.auction.info.ended() &&
    auctionView.auction.info.state !== AuctionState.Ended
  ) {
    await setupPlaceBid(
      connection,
      wallet,
      payingAccount,
      auctionView,
      accountsByMint,
      0,
      instructions,
      signers,
    );
  }

  const accountRentExempt = await connection.getMinimumBalanceForRentExemption(
    AccountLayout.span,
  );

  const mintRentExempt = await connection.getMinimumBalanceForRentExemption(
    MintLayout.span,
  );

  let winnerIndex = null;
  if (auctionView.myBidderPot?.pubkey)
    winnerIndex = auctionView.auction.info.bidState.getWinnerIndex(
      auctionView.myBidderPot?.info.bidderAct,
    );
  console.log('Winner index', winnerIndex);

  if (winnerIndex !== null) {
    const winningConfig =
      auctionView.auctionManager.info.settings.winningConfigs[winnerIndex];
    const winningSet = auctionView.items[winnerIndex];

    for (let i = 0; i < winningSet.length; i++) {
      const item = winningSet[i];
      const safetyDeposit = item.safetyDeposit;
      // In principle it is possible to have two winning config items of same safety deposit box
      // so we cover for that possibility by doing an array not a find
      for (let j = 0; j < winningConfig.items.length; j++) {
        const winningConfigItem = winningConfig.items[j];

        if (
          winningConfigItem.safetyDepositBoxIndex === safetyDeposit.info.order
        ) {
          const stateItem =
            auctionView.auctionManager.info.state.winningConfigStates[
              winnerIndex
            ].items[j];
          switch (winningConfigItem.winningConfigType) {
            case WinningConfigType.PrintingV1:
              console.log('Redeeming printing v1');
              await deprecatedSetupRedeemPrintingV1Instructions(
                auctionView,
                accountsByMint,
                accountRentExempt,
                mintRentExempt,
                wallet,
                safetyDeposit,
                item,
                signers,
                instructions,
                winningConfigItem,
                stateItem,
              );
              break;
            case WinningConfigType.PrintingV2:
              console.log('Redeeming printing v2');
              await setupRedeemPrintingV2Instructions(
                auctionView,
                mintRentExempt,
                wallet,
                safetyDeposit,
                item,
                signers,
                instructions,
                winningConfigItem,
                stateItem,
                winnerIndex,
                prizeTrackingTickets,
              );
              break;
            case WinningConfigType.FullRightsTransfer:
              console.log('Redeeming Full Rights');
              await setupRedeemFullRightsTransferInstructions(
                auctionView,
                accountsByMint,
                accountRentExempt,
                wallet,
                safetyDeposit,
                item,
                signers,
                instructions,
                stateItem,
              );
              break;
            case WinningConfigType.TokenOnlyTransfer:
              console.log('Redeeming Token only');
              await setupRedeemInstructions(
                auctionView,
                accountsByMint,
                accountRentExempt,
                wallet,
                safetyDeposit,
                signers,
                instructions,
                stateItem,
              );
              break;
          }
        }
      }
    }

    if (auctionView.myBidderMetadata && auctionView.myBidderPot) {
      let claimSigners: Keypair[] = [];
      let claimInstructions: TransactionInstruction[] = [];
      instructions.push(claimInstructions);
      signers.push(claimSigners);
      console.log('Claimed');
      await claimBid(
        auctionView.auctionManager.info.acceptPayment,
        auctionView.myBidderMetadata.info.bidderPubkey,
        auctionView.myBidderPot?.info.bidderPot,
        auctionView.vault.pubkey,
        auctionView.auction.info.tokenMint,
        claimInstructions,
      );
    }
  } else {
    // If you didnt win, you must have a bid we can refund before we check for open editions.
    await setupCancelBid(
      auctionView,
      accountsByMint,
      accountRentExempt,
      wallet,
      signers,
      instructions,
    );
  }

  if (
    auctionView.participationItem &&
    eligibleForParticipationPrizeGivenWinningIndex(winnerIndex, auctionView)
  ) {
    const item = auctionView.participationItem;
    const safetyDeposit = item.safetyDeposit;
    if (item.masterEdition?.info.key == MetadataKey.MasterEditionV1) {
      await deprecatedSetupRedeemParticipationInstructions(
        connection,
        auctionView,
        accountsByMint,
        accountRentExempt,
        mintRentExempt,
        wallet,
        safetyDeposit,
        item,
        signers,
        instructions,
      );
    } else {
      await setupRedeemParticipationInstructions(
        auctionView,
        accountsByMint,
        accountRentExempt,
        mintRentExempt,
        wallet,
        safetyDeposit,
        item,
        signers,
        instructions,
      );
    }
  }

  if (wallet.publicKey.equals(auctionView.auctionManager.info.authority)) {
    await claimUnusedPrizes(
      connection,
      wallet,
      auctionView,
      accountsByMint,
      signers,
      instructions,
    );
  }

  await sendTransactionsWithManualRetry(
    connection,
    wallet,
    instructions,
    signers,
  );
}

async function setupRedeemInstructions(
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  accountRentExempt: number,
  wallet: any,
  safetyDeposit: ParsedAccount<SafetyDepositBox>,
  signers: Array<Keypair[]>,
  instructions: Array<TransactionInstruction[]>,
  stateItem: WinningConfigStateItem,
) {
  let winningPrizeSigner: Keypair[] = [];
  let winningPrizeInstructions: TransactionInstruction[] = [];

  signers.push(winningPrizeSigner);
  instructions.push(winningPrizeInstructions);
  if (!stateItem.claimed && auctionView.myBidderMetadata) {
    let newTokenAccount = accountsByMint.get(
      safetyDeposit.info.tokenMint.toBase58(),
    )?.pubkey;
    if (!newTokenAccount)
      newTokenAccount = createTokenAccount(
        winningPrizeInstructions,
        wallet.publicKey,
        accountRentExempt,
        safetyDeposit.info.tokenMint,
        wallet.publicKey,
        winningPrizeSigner,
      );

    await redeemBid(
      auctionView.auctionManager.info.vault,
      safetyDeposit.info.store,
      newTokenAccount,
      safetyDeposit.pubkey,
      auctionView.vault.info.fractionMint,
      auctionView.myBidderMetadata.info.bidderPubkey,
      wallet.publicKey,
      undefined,
      undefined,
      false,
      winningPrizeInstructions,
    );

    const metadata = await getMetadata(safetyDeposit.info.tokenMint);
    await updatePrimarySaleHappenedViaToken(
      metadata,
      wallet.publicKey,
      newTokenAccount,
      winningPrizeInstructions,
    );
  }
}

async function setupRedeemFullRightsTransferInstructions(
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  accountRentExempt: number,
  wallet: any,
  safetyDeposit: ParsedAccount<SafetyDepositBox>,
  item: AuctionViewItem,
  signers: Array<Keypair[]>,
  instructions: Array<TransactionInstruction[]>,
  stateItem: WinningConfigStateItem,
) {
  let winningPrizeSigner: Keypair[] = [];
  let winningPrizeInstructions: TransactionInstruction[] = [];

  signers.push(winningPrizeSigner);
  instructions.push(winningPrizeInstructions);
  if (!stateItem.claimed && auctionView.myBidderMetadata) {
    let newTokenAccount = accountsByMint.get(
      safetyDeposit.info.tokenMint.toBase58(),
    )?.pubkey;
    if (!newTokenAccount)
      newTokenAccount = createTokenAccount(
        winningPrizeInstructions,
        wallet.publicKey,
        accountRentExempt,
        safetyDeposit.info.tokenMint,
        wallet.publicKey,
        winningPrizeSigner,
      );

    await redeemFullRightsTransferBid(
      auctionView.auctionManager.info.vault,
      safetyDeposit.info.store,
      newTokenAccount,
      safetyDeposit.pubkey,
      auctionView.vault.info.fractionMint,
      auctionView.myBidderMetadata.info.bidderPubkey,
      wallet.publicKey,
      winningPrizeInstructions,
      item.metadata.pubkey,
      wallet.publicKey,
    );

    const metadata = await getMetadata(safetyDeposit.info.tokenMint);
    await updatePrimarySaleHappenedViaToken(
      metadata,
      wallet.publicKey,
      newTokenAccount,
      winningPrizeInstructions,
    );
  }
}

async function createMintAndAccountWithOne(
  wallet: any,
  mintRent: any,
  instructions: TransactionInstruction[],
  signers: Keypair[],
): Promise<{ mint: PublicKey; account: PublicKey }> {
  const mint = createMint(
    instructions,
    wallet.publicKey,
    mintRent,
    0,
    wallet.publicKey,
    wallet.publicKey,
    signers,
  );

  const PROGRAM_IDS = programIds();

  const account: PublicKey = (
    await findProgramAddress(
      [
        wallet.publicKey.toBuffer(),
        PROGRAM_IDS.token.toBuffer(),
        mint.toBuffer(),
      ],
      PROGRAM_IDS.associatedToken,
    )
  )[0];

  createAssociatedTokenAccountInstruction(
    instructions,
    account,
    wallet.publicKey,
    wallet.publicKey,
    mint,
  );

  instructions.push(
    Token.createMintToInstruction(
      PROGRAM_IDS.token,
      mint,
      account,
      wallet.publicKey,
      [],
      1,
    ),
  );

  return { mint, account };
}

async function setupRedeemPrintingV2Instructions(
  auctionView: AuctionView,
  mintRentExempt: number,
  wallet: any,
  safetyDeposit: ParsedAccount<SafetyDepositBox>,
  item: AuctionViewItem,
  signers: Array<Keypair[]>,
  instructions: Array<TransactionInstruction[]>,
  winningConfigItem: WinningConfigItem,
  stateItem: WinningConfigStateItem,
  winningIndex: number,
  prizeTrackingTickets: Record<string, ParsedAccount<PrizeTrackingTicket>>,
) {
  if (!item.masterEdition || !item.metadata) {
    return;
  }
  if (!stateItem.claimed) {
    const me = item.masterEdition as ParsedAccount<MasterEditionV2>;

    let myInstructions: TransactionInstruction[] = [];
    let mySigners: Keypair[] = [];

    const myPrizeTrackingTicketKey = await getPrizeTrackingTicket(
      auctionView.auctionManager.pubkey,
      item.metadata.info.mint,
    );

    const myPrizeTrackingTicket =
      prizeTrackingTickets[myPrizeTrackingTicketKey.toBase58()];
    // We are not entirely guaranteed this is right. Someone could be clicking at the same time. Contract will throw error if this
    // is the case and they'll need to refresh to get tracking ticket which may not have existed when they first clicked.
    const editionBase = myPrizeTrackingTicket
      ? myPrizeTrackingTicket.info.supplySnapshot
      : me.info.supply;
    let offset = 1;
    auctionView.auctionManager.info.settings.winningConfigs.forEach(
      (wc, index) =>
        index < winningIndex &&
        wc.items.forEach(i => {
          if (
            i.safetyDepositBoxIndex === item.safetyDeposit.info.order &&
            i.winningConfigType === winningConfigItem.winningConfigType
          ) {
            offset += i.amount;
          }
        }),
    );

    const { mint, account } = await createMintAndAccountWithOne(
      wallet,
      mintRentExempt,
      myInstructions,
      mySigners,
    );

    const winIndex =
      auctionView.auction.info.bidState.getWinnerIndex(wallet.publicKey) || 0;

    await redeemPrintingV2Bid(
      auctionView.vault.pubkey,
      safetyDeposit.info.store,
      account,
      safetyDeposit.pubkey,
      auctionView.vault.info.fractionMint,
      wallet.publicKey,
      wallet.publicKey,
      item.metadata.pubkey,
      me.pubkey,
      item.metadata.info.mint,
      mint,
      editionBase.add(new BN(offset)),
      new BN(offset),
      new BN(winIndex),
      myInstructions,
    );

    const metadata = await getMetadata(mint);

    await updatePrimarySaleHappenedViaToken(
      metadata,
      wallet.publicKey,
      account,
      myInstructions,
    );
    instructions.push(myInstructions);
    signers.push(mySigners);
  } else {
    console.log('Item is already claimed!', item.metadata.info.mint.toBase58());
  }
}

async function deprecatedSetupRedeemPrintingV1Instructions(
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  accountRentExempt: number,
  mintRentExempt: number,
  wallet: any,
  safetyDeposit: ParsedAccount<SafetyDepositBox>,
  item: AuctionViewItem,
  signers: Array<Keypair[]>,
  instructions: Array<TransactionInstruction[]>,
  winningConfigItem: WinningConfigItem,
  stateItem: WinningConfigStateItem,
) {
  if (!item.masterEdition || !item.metadata) {
    return;
  }
  const updateAuth = item.metadata.info.updateAuthority;

  const reservationList = await deprecatedGetReservationList(
    item.masterEdition.pubkey,
    auctionView.auctionManager.pubkey,
  );

  const me = item.masterEdition as ParsedAccount<MasterEditionV1>;

  const newTokenAccount = accountsByMint.get(me.info.printingMint.toBase58());
  let newTokenAccountKey: PublicKey | undefined = newTokenAccount?.pubkey;

  let newTokenAccountBalance: number = newTokenAccount
    ? newTokenAccount.info.amount.toNumber()
    : 0;

  if (updateAuth && auctionView.myBidderMetadata) {
    console.log('This state item is', stateItem.claimed);
    if (!stateItem.claimed) {
      let winningPrizeSigner: Keypair[] = [];
      let winningPrizeInstructions: TransactionInstruction[] = [];

      signers.push(winningPrizeSigner);
      instructions.push(winningPrizeInstructions);
      if (!newTokenAccountKey)
        // TODO: switch to ATA
        newTokenAccountKey = createTokenAccount(
          winningPrizeInstructions,
          wallet.publicKey,
          accountRentExempt,
          me.info.printingMint,
          wallet.publicKey,
          winningPrizeSigner,
        );

      await redeemBid(
        auctionView.auctionManager.info.vault,
        safetyDeposit.info.store,
        newTokenAccountKey,
        safetyDeposit.pubkey,
        auctionView.vault.info.fractionMint,
        auctionView.myBidderMetadata.info.bidderPubkey,
        wallet.publicKey,
        item.masterEdition.pubkey,
        reservationList,
        true,
        winningPrizeInstructions,
      );
      newTokenAccountBalance = winningConfigItem.amount;
    }

    if (newTokenAccountKey && newTokenAccountBalance > 0)
      for (let i = 0; i < newTokenAccountBalance; i++) {
        console.log('Redeeming v1 token', i);
        await deprecatedRedeemPrintingV1Token(
          wallet,
          updateAuth,
          item,
          newTokenAccountKey,
          mintRentExempt,
          accountRentExempt,
          signers,
          instructions,
          reservationList,
        );
      }
  }
}

async function deprecatedRedeemPrintingV1Token(
  wallet: any,
  updateAuth: PublicKey,
  item: AuctionViewItem,
  newTokenAccount: PublicKey,
  mintRentExempt: number,
  accountRentExempt: number,
  signers: Keypair[][],
  instructions: TransactionInstruction[][],
  reservationList?: PublicKey,
) {
  if (!item.masterEdition) return;
  let cashInLimitedPrizeAuthorizationTokenSigner: Keypair[] = [];
  let cashInLimitedPrizeAuthorizationTokenInstruction: TransactionInstruction[] =
    [];
  signers.push(cashInLimitedPrizeAuthorizationTokenSigner);
  instructions.push(cashInLimitedPrizeAuthorizationTokenInstruction);

  const newLimitedEditionMint = createMint(
    cashInLimitedPrizeAuthorizationTokenInstruction,
    wallet.publicKey,
    mintRentExempt,
    0,
    wallet.publicKey,
    wallet.publicKey,
    cashInLimitedPrizeAuthorizationTokenSigner,
  );
  const newLimitedEdition = createTokenAccount(
    cashInLimitedPrizeAuthorizationTokenInstruction,
    wallet.publicKey,
    accountRentExempt,
    newLimitedEditionMint,
    wallet.publicKey,
    cashInLimitedPrizeAuthorizationTokenSigner,
  );

  cashInLimitedPrizeAuthorizationTokenInstruction.push(
    Token.createMintToInstruction(
      programIds().token,
      newLimitedEditionMint,
      newLimitedEdition,
      wallet.publicKey,
      [],
      1,
    ),
  );

  const burnAuthority = approve(
    cashInLimitedPrizeAuthorizationTokenInstruction,
    [],
    newTokenAccount,
    wallet.publicKey,
    1,
  );

  cashInLimitedPrizeAuthorizationTokenSigner.push(burnAuthority);

  const me = item.masterEdition as ParsedAccount<MasterEditionV1>;

  await deprecatedMintNewEditionFromMasterEditionViaPrintingToken(
    newLimitedEditionMint,
    item.metadata.info.mint,
    wallet.publicKey,
    me.info.printingMint,
    newTokenAccount,
    burnAuthority.publicKey,
    updateAuth,
    reservationList,
    cashInLimitedPrizeAuthorizationTokenInstruction,
    wallet.publicKey,
  );

  const metadata = await getMetadata(newLimitedEditionMint);
  await updatePrimarySaleHappenedViaToken(
    metadata,
    wallet.publicKey,
    newLimitedEdition,
    cashInLimitedPrizeAuthorizationTokenInstruction,
  );
}

async function setupRedeemParticipationInstructions(
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  accountRentExempt: number,
  mintRentExempt: number,
  wallet: any,
  safetyDeposit: ParsedAccount<SafetyDepositBox>,
  item: AuctionViewItem,
  signers: Array<Keypair[]>,
  instructions: Array<TransactionInstruction[]>,
) {
  if (!item.masterEdition || !item.metadata) {
    return;
  }

  if (!auctionView.myBidRedemption?.info.participationRedeemed) {
    const me = item.masterEdition as ParsedAccount<MasterEditionV2>;

    let myInstructions: TransactionInstruction[] = [];
    const cleanupInstructions: TransactionInstruction[] = [];

    let mySigners: Keypair[] = [];

    const { mint, account } = await createMintAndAccountWithOne(
      wallet,
      mintRentExempt,
      myInstructions,
      mySigners,
    );

    let tokenAccount = accountsByMint.get(
      auctionView.auction.info.tokenMint.toBase58(),
    );

    const fixedPrice =
      auctionView.auctionManager.info.settings.participationConfig?.fixedPrice;
    let price: number =
      fixedPrice !== undefined && fixedPrice !== null
        ? fixedPrice.toNumber()
        : auctionView.myBidderMetadata?.info.lastBid.toNumber() || 0;

    const payingSolAccount = ensureWrappedAccount(
      myInstructions,
      cleanupInstructions,
      tokenAccount,
      wallet.publicKey,
      price + accountRentExempt,
      mySigners,
    );

    const transferAuthority = approve(
      myInstructions,
      cleanupInstructions,
      payingSolAccount,
      wallet.publicKey,
      price,
    );

    mySigners.push(transferAuthority);

    await redeemParticipationBidV2(
      auctionView.vault.pubkey,
      safetyDeposit.info.store,
      account,
      safetyDeposit.pubkey,
      auctionView.vault.info.fractionMint,
      wallet.publicKey,
      wallet.publicKey,
      item.metadata.pubkey,
      me.pubkey,
      item.metadata.info.mint,
      transferAuthority.publicKey,
      auctionView.auctionManager.info.acceptPayment,
      payingSolAccount,
      mint,
      me.info.supply.add(new BN(1)),
      myInstructions,
    );
    instructions.push([...myInstructions, ...cleanupInstructions]);
    signers.push(mySigners);
    const metadata = await getMetadata(mint);

    await updatePrimarySaleHappenedViaToken(
      metadata,
      wallet.publicKey,
      account,
      myInstructions,
    );
  } else {
    console.log('Item is already claimed!', item.metadata.info.mint.toBase58());
  }
}

async function deprecatedSetupRedeemParticipationInstructions(
  connection: Connection,
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  accountRentExempt: number,
  mintRentExempt: number,
  wallet: any,
  safetyDeposit: ParsedAccount<SafetyDepositBox>,
  item: AuctionViewItem,
  signers: Array<Keypair[]>,
  instructions: Array<TransactionInstruction[]>,
) {
  const me = item.masterEdition as ParsedAccount<MasterEditionV1>;
  if (
    !auctionView.auctionManager.info.state.participationState
      ?.printingAuthorizationTokenAccount ||
    !me?.info.oneTimePrintingAuthorizationMint ||
    !item.metadata
  )
    return;

  const updateAuth = item.metadata.info.updateAuthority;
  let tokenAccount = accountsByMint.get(
    auctionView.auction.info.tokenMint.toBase58(),
  );
  const mint = cache.get(auctionView.auction.info.tokenMint);

  const participationBalance = await connection.getTokenAccountBalance(
    auctionView.auctionManager.info.state.participationState
      .printingAuthorizationTokenAccount,
  );
  const tokenBalance = await connection.getTokenAccountBalance(
    safetyDeposit.info.store,
  );

  if (
    participationBalance.value.uiAmount === 0 &&
    tokenBalance.value.uiAmount === 1
  ) {
    // I'm the first, I need to populate for the others with a crank turn.
    let fillParticipationStashSigners: Keypair[] = [];
    let fillParticipationStashInstructions: TransactionInstruction[] = [];
    const oneTimeTransient = createTokenAccount(
      fillParticipationStashInstructions,
      wallet.publicKey,
      accountRentExempt,
      me?.info.oneTimePrintingAuthorizationMint,
      auctionView.auctionManager.pubkey,
      fillParticipationStashSigners,
    );

    await deprecatedPopulateParticipationPrintingAccount(
      auctionView.vault.pubkey,
      auctionView.auctionManager.pubkey,
      auctionView.auction.pubkey,
      safetyDeposit.info.store,
      oneTimeTransient,
      auctionView.auctionManager.info.state.participationState
        .printingAuthorizationTokenAccount,
      safetyDeposit.pubkey,
      auctionView.vault.info.fractionMint,
      me.info.printingMint,
      me.info.oneTimePrintingAuthorizationMint,
      me.pubkey,
      item.metadata.pubkey,
      wallet.publicKey,
      fillParticipationStashInstructions,
    );

    signers.push(fillParticipationStashSigners);
    instructions.push(fillParticipationStashInstructions);
  }

  let newTokenAccount: PublicKey | undefined = accountsByMint.get(
    me.info.printingMint.toBase58(),
  )?.pubkey;

  let newTokenBalance =
    accountsByMint.get(me.info.printingMint.toBase58())?.info.amount || 0;

  if (
    me &&
    updateAuth &&
    auctionView.myBidderMetadata &&
    mint &&
    !auctionView.myBidRedemption?.info.participationRedeemed
  ) {
    if (!auctionView.myBidRedemption?.info.participationRedeemed) {
      let winningPrizeSigner: Keypair[] = [];
      let winningPrizeInstructions: TransactionInstruction[] = [];
      let cleanupInstructions: TransactionInstruction[] = [];

      if (!newTokenAccount) {
        // made a separate txn because we're over the txn limit by like 10 bytes.
        let newTokenAccountSigner: Keypair[] = [];
        let newTokenAccountInstructions: TransactionInstruction[] = [];
        signers.push(newTokenAccountSigner);
        instructions.push(newTokenAccountInstructions);
        newTokenAccount = createTokenAccount(
          newTokenAccountInstructions,
          wallet.publicKey,
          accountRentExempt,
          me.info.printingMint,
          wallet.publicKey,
          newTokenAccountSigner,
        );
      }
      signers.push(winningPrizeSigner);

      const fixedPrice =
        auctionView.auctionManager.info.settings.participationConfig
          ?.fixedPrice;
      let price: number =
        fixedPrice !== undefined && fixedPrice !== null
          ? fixedPrice.toNumber()
          : auctionView.myBidderMetadata.info.lastBid.toNumber() || 0;

      const payingSolAccount = ensureWrappedAccount(
        winningPrizeInstructions,
        cleanupInstructions,
        tokenAccount,
        wallet.publicKey,
        price + accountRentExempt,
        winningPrizeSigner,
      );

      const transferAuthority = approve(
        winningPrizeInstructions,
        cleanupInstructions,
        payingSolAccount,
        wallet.publicKey,
        price,
      );

      winningPrizeSigner.push(transferAuthority);

      await deprecatedRedeemParticipationBid(
        auctionView.auctionManager.info.vault,
        safetyDeposit.info.store,
        newTokenAccount,
        safetyDeposit.pubkey,
        auctionView.vault.info.fractionMint,
        auctionView.myBidderMetadata.info.bidderPubkey,
        wallet.publicKey,
        winningPrizeInstructions,
        item.metadata.info.mint,
        auctionView.auctionManager.info.state.participationState
          .printingAuthorizationTokenAccount,
        transferAuthority.publicKey,
        auctionView.auctionManager.info.acceptPayment,
        payingSolAccount,
      );
      newTokenBalance = 1;
      instructions.push([...winningPrizeInstructions, ...cleanupInstructions]);
    }
  }

  if (newTokenAccount && newTokenBalance === 1) {
    await deprecatedRedeemPrintingV1Token(
      wallet,
      updateAuth,
      item,
      newTokenAccount,
      mintRentExempt,
      accountRentExempt,
      signers,
      instructions,
      undefined,
    );
  }
}
