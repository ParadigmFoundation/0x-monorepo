"""Generated wrapper for LibDummy Solidity contract."""

# pylint: disable=too-many-arguments

import json
from typing import (  # pylint: disable=unused-import
    Any,
    List,
    Optional,
    Tuple,
    Union,
)

from mypy_extensions import TypedDict  # pylint: disable=unused-import
from hexbytes import HexBytes
from web3.datastructures import AttributeDict
from web3.providers.base import BaseProvider

from zero_ex.contract_wrappers._base_contract_wrapper import BaseContractWrapper
from zero_ex.contract_wrappers.tx_params import TxParams


class LibDummyValidatorBase:
    """Base class for validating inputs to LibDummy methods."""
    def __init__(
        self,
        provider: BaseProvider,
        contract_address: str,
        private_key: str = None,
    ):
        """Initialize the instance."""

    def assert_valid(
        self, method_name: str, parameter_name: str, argument_value: Any
    ):
        """Raise an exception if method input is not valid.

        :param method_name: Name of the method whose input is to be validated.
        :param parameter_name: Name of the parameter whose input is to be
            validated.
        :param argument_value: Value of argument to parameter to be validated.
        """


# Try to import a custom validator class definition; if there isn't one,
# declare one that we can instantiate for the default argument to the
# constructor for LibDummy below.
try:
    # both mypy and pylint complain about what we're doing here, but this
    # works just fine, so their messages have been disabled here.
    from . import (  # type: ignore # pylint: disable=import-self
        LibDummyValidator,
    )
except ImportError:

    class LibDummyValidator(LibDummyValidatorBase):  # type: ignore
        """No-op input validator."""





# pylint: disable=too-many-public-methods
class LibDummy(BaseContractWrapper):
    """Wrapper class for LibDummy Solidity contract."""

    def __init__(
        self,
        provider: BaseProvider,
        contract_address: str,
        validator: LibDummyValidator = None,
        private_key: str = None,
    ):
        """Get an instance of wrapper for smart contract.

        :param provider: instance of :class:`web3.providers.base.BaseProvider`
        :param contract_address: where the contract has been deployed
        :param private_key: If specified, transactions will be signed locally,
            via Web3.py's `eth.account.signTransaction()`:code:, before being
            sent via `eth.sendRawTransaction()`:code:.
        """
        super().__init__(
            provider=provider,
            contract_address=contract_address,
            private_key=private_key,
        )

        if not validator:
            validator = LibDummyValidator(provider, contract_address, private_key)

        self.validator = validator

    def _get_contract_instance(self, token_address):
        """Get an instance of the smart contract at a specific address.

        :returns: contract object
        """
        return self._contract_instance(
            address=token_address, abi=LibDummy.abi()
        )

    @staticmethod
    def abi():
        """Return the ABI to the underlying contract."""
        return json.loads(
            '[]'  # noqa: E501 (line-too-long)
        )

# pylint: disable=too-many-lines
