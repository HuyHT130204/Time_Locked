# Time-Locked Wallet (Solana + Anchor + Next.js)

A modern, secure time-locked wallet application built on Solana blockchain with a beautiful, responsive UI.

## ✨ Features

- 🔐 **Multi-Wallet Support**: Phantom, Solflare, and other Solana wallets
- 💰 **SOL Locking**: Time-lock SOL tokens with custom unlock dates
- 🪙 **SPL Token Support**: Lock USDC and other SPL tokens
- 📱 **Responsive Design**: Beautiful glassmorphism UI that works on all devices
- ⚡ **Real-time Updates**: Automatic balance and lock status updates
- 🎨 **Modern UI**: Smooth animations and gradient effects
- 🔒 **Secure**: Built with Anchor framework for Solana

## 🚀 Quick Start

### Prerequisites
- Rust, Solana CLI, Anchor CLI (0.31.x)
- Node.js 18+
- Solana wallet (Phantom, Solflare, etc.)

### 1. Environment Configuration

Create a `.env.local` file in the `frontend/` directory:

```env
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_PROGRAM_ID=8LQG6U5AQKe9t97ogxMtggbr24QgUKNFz22qvVPzBYYe
NEXT_PUBLIC_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

### 2. Build and Deploy Program

```bash
cd timelock-wallet
anchor build
anchor deploy --provider.cluster devnet
```

Copy the printed Program ID and update `timelock-wallet/Anchor.toml` and `frontend/.env.local`.

### 3. Generate IDL (if re-building types)

```bash
anchor idl build --out target/idl/timelock_wallet.json
```

### 4. Frontend Setup

```bash
cd ../frontend
cp ../timelock-wallet/target/idl/timelock_wallet.json src/idl/timelock_wallet.json
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## 🎯 Usage

### Getting Started
1. **Connect Wallet**: Click "Connect Wallet" and select your Solana wallet
2. **Get Test SOL**: Use the "Airdrop 1 SOL" button to get devnet SOL
3. **Create Time Lock**: Choose asset type, amount, and unlock date
4. **Monitor**: View your active locks and their status
5. **Withdraw**: Withdraw funds after the lock period expires

### Supported Assets
- **SOL**: Native Solana tokens
- **USDC**: Circle's USD Coin on devnet
- **Other SPL Tokens**: Any SPL token with proper mint address

## 🔧 Troubleshooting

### Common Issues & Solutions

**"Failed to execute 'observe' on 'MutationObserver'"**
- This is usually a wallet adapter issue
- Try refreshing the page or reconnecting your wallet
- Ensure you're using a supported browser (Chrome, Firefox, Safari)

**"Cannot read properties of undefined (reading 'size')"**
- Check that your `.env.local` file has the correct `NEXT_PUBLIC_PROGRAM_ID`
- Ensure the program is deployed to devnet
- Try reconnecting your wallet

**"Error creating program"**
- Verify your RPC URL is accessible
- Check network connectivity
- Ensure wallet is properly connected

**"Error airdropping"**
- Devnet airdrops are rate-limited
- Wait 2-3 minutes between airdrop attempts
- Use a different RPC endpoint if needed

### Performance Tips
- Use a reliable RPC endpoint for better performance
- Consider using a local Solana validator for development
- Monitor network congestion on devnet

## 🌐 Alternative RPC Endpoints

If the default RPC is slow, try these alternatives:

```env
# Option 1: Helius
NEXT_PUBLIC_RPC_URL=https://rpc-devnet.helius.xyz/?api-key=YOUR_API_KEY

# Option 2: QuickNode
NEXT_PUBLIC_RPC_URL=https://your-endpoint.solana-devnet.quiknode.pro/YOUR_API_KEY/

# Option 3: GenesysGo
NEXT_PUBLIC_RPC_URL=https://ssltestnet.solana.com
```

## 🏗️ Architecture

### Smart Contract (Anchor)
- **Program ID**: `GSkBEUdNJCrVP7TyXWxWTCyeCACCXAKPN5gQMFWKgxic`
- **Features**: SOL and SPL token time-locking with PDA accounts
- **Security**: Time-based validation and proper account constraints

### Frontend (Next.js 15 + Tailwind CSS v4)
- **Framework**: Next.js 15 with App Router
- **Styling**: Tailwind CSS v4 with custom CSS variables
- **Wallet Integration**: Solana wallet adapters with error handling
- **State Management**: React hooks with proper dependency management

### Key Components
- `TimeLockForm.tsx`: Main application with lock creation and management
- `WalletProviders.tsx`: Wallet connection setup
- `anchorClient.ts`: Anchor program client with error handling
- `globals.css`: Custom styling with glassmorphism effects

## 📱 Supported Wallets

- **Phantom** (Recommended)
- **Solflare**
- **Backpack**
- **Other Solana wallet adapters**

## 🚨 Important Notes

- **Devnet Only**: This is for testing purposes
- **Rate Limits**: Airdrops are limited to prevent abuse
- **Network Congestion**: Devnet can be slow during high usage
- **Wallet Security**: Never share private keys or seed phrases

## 🔄 Development

### Project Structure
```
├── frontend/                 # Next.js frontend application
│   ├── src/
│   │   ├── app/             # Next.js app router
│   │   ├── components/      # React components
│   │   ├── lib/             # Utility functions
│   │   └── idl/             # Anchor IDL files
│   └── package.json
├── timelock-wallet/          # Anchor smart contract
│   ├── programs/            # Solana program source
│   └── Anchor.toml         # Anchor configuration
└── README.md
```

### Key Commands
```bash
# Frontend
npm run dev          # Development server
npm run build        # Production build
npm run start        # Production server

# Smart Contract
anchor build         # Build program
anchor deploy        # Deploy to network
anchor test          # Run tests
```

## 📞 Support

If you encounter issues:
1. Check this troubleshooting guide
2. Verify your configuration
3. Check Solana devnet status
4. Review browser console for errors
5. Check the `SETUP.md` file for detailed setup instructions

## 🔄 Updates

Keep your dependencies updated:
```bash
cd frontend
npm update
npm audit fix
```

## 📄 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

- Solana Labs for the blockchain platform
- Anchor team for the development framework
- Next.js team for the React framework
- Tailwind CSS team for the styling framework
