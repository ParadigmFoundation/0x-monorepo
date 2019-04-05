import { ERC20ProxyContract, ERC20Wrapper } from '@0x/contracts-asset-proxy';
import { DummyERC20TokenContract } from '@0x/contracts-erc20';
import {
    chaiSetup,
    constants,
    ERC20BalancesByOwner,
    OrderFactory,
    orderUtils,
    provider,
    TransactionFactory,
    txDefaults,
    web3Wrapper,
} from '@0x/contracts-test-utils';
import { BlockchainLifecycle } from '@0x/dev-utils';
import {
    assetDataUtils,
    ExchangeRevertErrors,
    generatePseudoRandomSalt,
    orderHashUtils,
    transactionHashUtils,
} from '@0x/order-utils';
import {
    EIP712DomainWithDefaultSchema,
    OrderStatus,
    OrderWithoutDomain,
    RevertReason,
    SignedOrder,
    SignedZeroExTransaction,
} from '@0x/types';
import { BigNumber, providerUtils } from '@0x/utils';
import * as chai from 'chai';
import * as _ from 'lodash';

import { artifacts, ExchangeContract, ExchangeWrapper, ExchangeWrapperContract, WhitelistContract } from '../src/';

chaiSetup.configure();
const expect = chai.expect;
const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);

describe('Exchange transactions', () => {
    let chainId: number;
    let senderAddress: string;
    let owner: string;
    let makerAddress: string;
    let takerAddress: string;
    let feeRecipientAddress: string;

    let erc20TokenA: DummyERC20TokenContract;
    let erc20TokenB: DummyERC20TokenContract;
    let zrxToken: DummyERC20TokenContract;
    let exchange: ExchangeContract;
    let erc20Proxy: ERC20ProxyContract;

    let erc20Balances: ERC20BalancesByOwner;
    let domain: EIP712DomainWithDefaultSchema;
    let signedOrder: SignedOrder;
    let signedTx: SignedZeroExTransaction;
    let orderWithoutDomain: OrderWithoutDomain;
    let orderFactory: OrderFactory;
    let makerTransactionFactory: TransactionFactory;
    let takerTransactionFactory: TransactionFactory;
    let exchangeWrapper: ExchangeWrapper;
    let erc20Wrapper: ERC20Wrapper;

    let defaultMakerTokenAddress: string;
    let defaultTakerTokenAddress: string;
    let makerPrivateKey: Buffer;
    let takerPrivateKey: Buffer;

    before(async () => {
        await blockchainLifecycle.startAsync();
    });
    after(async () => {
        await blockchainLifecycle.revertAsync();
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });
    before(async () => {
        chainId = await providerUtils.getChainIdAsync(provider);
        const accounts = await web3Wrapper.getAvailableAddressesAsync();
        const usedAddresses = ([owner, senderAddress, makerAddress, takerAddress, feeRecipientAddress] = _.slice(
            accounts,
            0,
            5,
        ));

        erc20Wrapper = new ERC20Wrapper(provider, usedAddresses, owner);

        const numDummyErc20ToDeploy = 3;
        [erc20TokenA, erc20TokenB, zrxToken] = await erc20Wrapper.deployDummyTokensAsync(
            numDummyErc20ToDeploy,
            constants.DUMMY_TOKEN_DECIMALS,
        );
        erc20Proxy = await erc20Wrapper.deployProxyAsync();
        await erc20Wrapper.setBalancesAndAllowancesAsync();

        exchange = await ExchangeContract.deployFrom0xArtifactAsync(
            artifacts.Exchange,
            provider,
            txDefaults,
            assetDataUtils.encodeERC20AssetData(zrxToken.address),
            new BigNumber(chainId),
        );
        exchangeWrapper = new ExchangeWrapper(exchange, provider);
        await exchangeWrapper.registerAssetProxyAsync(erc20Proxy.address, owner);

        await web3Wrapper.awaitTransactionSuccessAsync(
            await erc20Proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, { from: owner }),
            constants.AWAIT_TRANSACTION_MINED_MS,
        );

        defaultMakerTokenAddress = erc20TokenA.address;
        defaultTakerTokenAddress = erc20TokenB.address;

        domain = {
            verifyingContractAddress: exchange.address,
            chainId,
        };

        const defaultOrderParams = {
            ...constants.STATIC_ORDER_PARAMS,
            senderAddress,
            makerAddress,
            feeRecipientAddress,
            makerAssetData: assetDataUtils.encodeERC20AssetData(defaultMakerTokenAddress),
            takerAssetData: assetDataUtils.encodeERC20AssetData(defaultTakerTokenAddress),
            domain,
        };
        makerPrivateKey = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
        takerPrivateKey = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
        orderFactory = new OrderFactory(makerPrivateKey, defaultOrderParams);
        makerTransactionFactory = new TransactionFactory(makerPrivateKey, exchange.address, chainId);
        takerTransactionFactory = new TransactionFactory(takerPrivateKey, exchange.address, chainId);
    });
    describe('executeTransaction', () => {
        describe('fillOrder', () => {
            let takerAssetFillAmount: BigNumber;
            beforeEach(async () => {
                erc20Balances = await erc20Wrapper.getBalancesAsync();
                signedOrder = await orderFactory.newSignedOrderAsync();
                orderWithoutDomain = orderUtils.getOrderWithoutDomain(signedOrder);

                takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);
                const data = exchange.fillOrder.getABIEncodedTransactionData(
                    orderWithoutDomain,
                    takerAssetFillAmount,
                    signedOrder.signature,
                );
                signedTx = takerTransactionFactory.newSignedTransaction(data);
            });

            it('should throw if not called by specified sender', async () => {
                const orderHashHex = orderHashUtils.getOrderHashHex(signedOrder);
                const transactionHashHex = transactionHashUtils.getTransactionHashHex(signedTx);
                const expectedError = new ExchangeRevertErrors.TransactionExecutionError(
                    transactionHashHex,
                    new ExchangeRevertErrors.InvalidSenderError(orderHashHex, takerAddress).encode(),
                );
                const tx = exchangeWrapper.executeTransactionAsync(signedTx, takerAddress);
                return expect(tx).to.revertWith(expectedError);
            });

            it('should transfer the correct amounts when signed by taker and called by sender', async () => {
                await exchangeWrapper.executeTransactionAsync(signedTx, senderAddress);
                const newBalances = await erc20Wrapper.getBalancesAsync();
                const makerAssetFillAmount = takerAssetFillAmount
                    .times(signedOrder.makerAssetAmount)
                    .dividedToIntegerBy(signedOrder.takerAssetAmount);
                const makerFeePaid = signedOrder.makerFee
                    .times(makerAssetFillAmount)
                    .dividedToIntegerBy(signedOrder.makerAssetAmount);
                const takerFeePaid = signedOrder.takerFee
                    .times(makerAssetFillAmount)
                    .dividedToIntegerBy(signedOrder.makerAssetAmount);
                expect(newBalances[makerAddress][defaultMakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultMakerTokenAddress].minus(makerAssetFillAmount),
                );
                expect(newBalances[makerAddress][defaultTakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultTakerTokenAddress].plus(takerAssetFillAmount),
                );
                expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][zrxToken.address].minus(makerFeePaid),
                );
                expect(newBalances[takerAddress][defaultTakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultTakerTokenAddress].minus(takerAssetFillAmount),
                );
                expect(newBalances[takerAddress][defaultMakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultMakerTokenAddress].plus(makerAssetFillAmount),
                );
                expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][zrxToken.address].minus(takerFeePaid),
                );
                expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[feeRecipientAddress][zrxToken.address].plus(makerFeePaid.plus(takerFeePaid)),
                );
            });

            it('should throw if the a 0x transaction with the same transactionHash has already been executed', async () => {
                await exchangeWrapper.executeTransactionAsync(signedTx, senderAddress);
                const transactionHashHex = transactionHashUtils.getTransactionHashHex(signedTx);
                const expectedError = new ExchangeRevertErrors.TransactionError(
                    transactionHashHex,
                    ExchangeRevertErrors.TransactionErrorCode.AlreadyExecuted,
                );
                const tx = exchangeWrapper.executeTransactionAsync(signedTx, senderAddress);
                return expect(tx).to.revertWith(expectedError);
            });

            it('should reset the currentContextAddress', async () => {
                await exchangeWrapper.executeTransactionAsync(signedTx, senderAddress);
                const currentContextAddress = await exchange.currentContextAddress.callAsync();
                expect(currentContextAddress).to.equal(constants.NULL_ADDRESS);
            });
        });

        describe('cancelOrder', () => {
            beforeEach(async () => {
                const data = exchange.cancelOrder.getABIEncodedTransactionData(orderWithoutDomain);
                signedTx = makerTransactionFactory.newSignedTransaction(data);
            });

            it('should throw if not called by specified sender', async () => {
                const orderHashHex = orderHashUtils.getOrderHashHex(signedOrder);
                const transactionHashHex = transactionHashUtils.getTransactionHashHex(signedTx);
                const expectedError = new ExchangeRevertErrors.TransactionExecutionError(
                    transactionHashHex,
                    new ExchangeRevertErrors.InvalidSenderError(orderHashHex, makerAddress).encode(),
                );
                const tx = exchangeWrapper.executeTransactionAsync(signedTx, makerAddress);
                return expect(tx).to.revertWith(expectedError);
            });

            it('should cancel the order when signed by maker and called by sender', async () => {
                await exchangeWrapper.executeTransactionAsync(signedTx, senderAddress);
                const orderHashHex = orderHashUtils.getOrderHashHex(signedOrder);
                const expectedError = new ExchangeRevertErrors.OrderStatusError(
                    orderHashHex,
                    OrderStatus.Cancelled,
                );
                const tx = exchangeWrapper.fillOrderAsync(signedOrder, senderAddress);
                return expect(tx).to.revertWith(expectedError);
            });
        });

        describe('cancelOrdersUpTo', () => {
            let exchangeWrapperContract: ExchangeWrapperContract;

            before(async () => {
                exchangeWrapperContract = await ExchangeWrapperContract.deployFrom0xArtifactAsync(
                    artifacts.ExchangeWrapper,
                    provider,
                    txDefaults,
                    exchange.address,
                );
            });

            it("should cancel an order if called from the order's sender", async () => {
                const orderSalt = new BigNumber(0);
                signedOrder = await orderFactory.newSignedOrderAsync({
                    senderAddress: exchangeWrapperContract.address,
                    salt: orderSalt,
                });
                const targetOrderEpoch = orderSalt.plus(1);
                const cancelData = exchange.cancelOrdersUpTo.getABIEncodedTransactionData(targetOrderEpoch);
                const signedCancelTx = makerTransactionFactory.newSignedTransaction(cancelData);
                await exchangeWrapperContract.cancelOrdersUpTo.sendTransactionAsync(
                    targetOrderEpoch,
                    signedCancelTx.salt,
                    signedCancelTx.signature,
                    {
                        from: makerAddress,
                    },
                );

                const takerAssetFillAmount = signedOrder.takerAssetAmount;
                orderWithoutDomain = orderUtils.getOrderWithoutDomain(signedOrder);
                const fillData = exchange.fillOrder.getABIEncodedTransactionData(
                    orderWithoutDomain,
                    takerAssetFillAmount,
                    signedOrder.signature,
                );
                const signedFillTx = takerTransactionFactory.newSignedTransaction(fillData);
                const orderHashHex = orderHashUtils.getOrderHashHex(signedOrder);
                const transactionHashHex = transactionHashUtils.getTransactionHashHex(signedFillTx);
                const expectedError = new ExchangeRevertErrors.TransactionExecutionError(
                    transactionHashHex,
                    new ExchangeRevertErrors.OrderStatusError(orderHashHex, OrderStatus.Cancelled).encode(),
                );
                const tx = exchangeWrapperContract.fillOrder.sendTransactionAsync(
                    orderWithoutDomain,
                    takerAssetFillAmount,
                    signedFillTx.salt,
                    signedOrder.signature,
                    signedFillTx.signature,
                    { from: takerAddress },
                );
                return expect(tx).to.revertWith(expectedError);
            });

            it("should not cancel an order if not called from the order's sender", async () => {
                const orderSalt = new BigNumber(0);
                signedOrder = await orderFactory.newSignedOrderAsync({
                    senderAddress: exchangeWrapperContract.address,
                    salt: orderSalt,
                });
                const targetOrderEpoch = orderSalt.plus(1);
                await exchangeWrapper.cancelOrdersUpToAsync(targetOrderEpoch, makerAddress);

                erc20Balances = await erc20Wrapper.getBalancesAsync();
                const takerAssetFillAmount = signedOrder.takerAssetAmount;
                orderWithoutDomain = orderUtils.getOrderWithoutDomain(signedOrder);
                const data = exchange.fillOrder.getABIEncodedTransactionData(
                    orderWithoutDomain,
                    takerAssetFillAmount,
                    signedOrder.signature,
                );
                signedTx = takerTransactionFactory.newSignedTransaction(data);
                await exchangeWrapperContract.fillOrder.sendTransactionAsync(
                    orderWithoutDomain,
                    takerAssetFillAmount,
                    signedTx.salt,
                    signedOrder.signature,
                    signedTx.signature,
                    { from: takerAddress },
                );

                const newBalances = await erc20Wrapper.getBalancesAsync();
                const makerAssetFillAmount = takerAssetFillAmount
                    .times(signedOrder.makerAssetAmount)
                    .dividedToIntegerBy(signedOrder.takerAssetAmount);
                const makerFeePaid = signedOrder.makerFee
                    .times(makerAssetFillAmount)
                    .dividedToIntegerBy(signedOrder.makerAssetAmount);
                const takerFeePaid = signedOrder.takerFee
                    .times(makerAssetFillAmount)
                    .dividedToIntegerBy(signedOrder.makerAssetAmount);
                expect(newBalances[makerAddress][defaultMakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultMakerTokenAddress].minus(makerAssetFillAmount),
                );
                expect(newBalances[makerAddress][defaultTakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultTakerTokenAddress].plus(takerAssetFillAmount),
                );
                expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][zrxToken.address].minus(makerFeePaid),
                );
                expect(newBalances[takerAddress][defaultTakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultTakerTokenAddress].minus(takerAssetFillAmount),
                );
                expect(newBalances[takerAddress][defaultMakerTokenAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultMakerTokenAddress].plus(makerAssetFillAmount),
                );
                expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][zrxToken.address].minus(takerFeePaid),
                );
                expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[feeRecipientAddress][zrxToken.address].plus(makerFeePaid.plus(takerFeePaid)),
                );
            });
        });
    });

    describe('Whitelist', () => {
        let whitelist: WhitelistContract;
        let whitelistOrderFactory: OrderFactory;

        before(async () => {
            whitelist = await WhitelistContract.deployFrom0xArtifactAsync(
                artifacts.Whitelist,
                provider,
                txDefaults,
                exchange.address,
            );
            const isApproved = true;
            await web3Wrapper.awaitTransactionSuccessAsync(
                await exchange.setSignatureValidatorApproval.sendTransactionAsync(whitelist.address, isApproved, {
                    from: takerAddress,
                }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );
            const defaultOrderParams = {
                ...constants.STATIC_ORDER_PARAMS,
                senderAddress: whitelist.address,
                makerAddress,
                feeRecipientAddress,
                makerAssetData: assetDataUtils.encodeERC20AssetData(defaultMakerTokenAddress),
                takerAssetData: assetDataUtils.encodeERC20AssetData(defaultTakerTokenAddress),
                domain,
            };
            whitelistOrderFactory = new OrderFactory(makerPrivateKey, defaultOrderParams);
        });

        beforeEach(async () => {
            signedOrder = await whitelistOrderFactory.newSignedOrderAsync();
            erc20Balances = await erc20Wrapper.getBalancesAsync();
        });

        it('should revert if maker has not been whitelisted', async () => {
            const isApproved = true;
            await web3Wrapper.awaitTransactionSuccessAsync(
                await whitelist.updateWhitelistStatus.sendTransactionAsync(takerAddress, isApproved, { from: owner }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );

            orderWithoutDomain = orderUtils.getOrderWithoutDomain(signedOrder);
            const takerAssetFillAmount = signedOrder.takerAssetAmount;
            const salt = generatePseudoRandomSalt();
            const tx = whitelist.fillOrderIfWhitelisted.sendTransactionAsync(
                orderWithoutDomain,
                takerAssetFillAmount,
                salt,
                signedOrder.signature,
                { from: takerAddress },
            );
            return expect(tx).to.revertWith(RevertReason.MakerNotWhitelisted);
        });

        it('should revert if taker has not been whitelisted', async () => {
            const isApproved = true;
            await web3Wrapper.awaitTransactionSuccessAsync(
                await whitelist.updateWhitelistStatus.sendTransactionAsync(makerAddress, isApproved, { from: owner }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );

            orderWithoutDomain = orderUtils.getOrderWithoutDomain(signedOrder);
            const takerAssetFillAmount = signedOrder.takerAssetAmount;
            const salt = generatePseudoRandomSalt();
            const tx = whitelist.fillOrderIfWhitelisted.sendTransactionAsync(
                orderWithoutDomain,
                takerAssetFillAmount,
                salt,
                signedOrder.signature,
                { from: takerAddress },
            );
            return expect(tx).to.revertWith(RevertReason.TakerNotWhitelisted);
        });

        it('should fill the order if maker and taker have been whitelisted', async () => {
            const isApproved = true;
            await web3Wrapper.awaitTransactionSuccessAsync(
                await whitelist.updateWhitelistStatus.sendTransactionAsync(makerAddress, isApproved, { from: owner }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );

            await web3Wrapper.awaitTransactionSuccessAsync(
                await whitelist.updateWhitelistStatus.sendTransactionAsync(takerAddress, isApproved, { from: owner }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );

            orderWithoutDomain = orderUtils.getOrderWithoutDomain(signedOrder);
            const takerAssetFillAmount = signedOrder.takerAssetAmount;
            const salt = generatePseudoRandomSalt();
            await web3Wrapper.awaitTransactionSuccessAsync(
                await whitelist.fillOrderIfWhitelisted.sendTransactionAsync(
                    orderWithoutDomain,
                    takerAssetFillAmount,
                    salt,
                    signedOrder.signature,
                    { from: takerAddress },
                ),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );

            const newBalances = await erc20Wrapper.getBalancesAsync();

            const makerAssetFillAmount = signedOrder.makerAssetAmount;
            const makerFeePaid = signedOrder.makerFee;
            const takerFeePaid = signedOrder.takerFee;

            expect(newBalances[makerAddress][defaultMakerTokenAddress]).to.be.bignumber.equal(
                erc20Balances[makerAddress][defaultMakerTokenAddress].minus(makerAssetFillAmount),
            );
            expect(newBalances[makerAddress][defaultTakerTokenAddress]).to.be.bignumber.equal(
                erc20Balances[makerAddress][defaultTakerTokenAddress].plus(takerAssetFillAmount),
            );
            expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[makerAddress][zrxToken.address].minus(makerFeePaid),
            );
            expect(newBalances[takerAddress][defaultTakerTokenAddress]).to.be.bignumber.equal(
                erc20Balances[takerAddress][defaultTakerTokenAddress].minus(takerAssetFillAmount),
            );
            expect(newBalances[takerAddress][defaultMakerTokenAddress]).to.be.bignumber.equal(
                erc20Balances[takerAddress][defaultMakerTokenAddress].plus(makerAssetFillAmount),
            );
            expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[takerAddress][zrxToken.address].minus(takerFeePaid),
            );
            expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[feeRecipientAddress][zrxToken.address].plus(makerFeePaid.plus(takerFeePaid)),
            );
        });
    });
});
