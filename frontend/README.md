# Time-Locked Wallet Frontend

A modern, responsive web application for creating and managing time-locked wallets on Solana blockchain.

## Features

- 🔐 **Wallet Connection**: Support for Phantom and Solflare wallets
- 💰 **SOL Locking**: Time-lock SOL tokens with custom unlock dates
- 🪙 **SPL Token Support**: Lock USDC and other SPL tokens
- 📱 **Responsive Design**: Beautiful UI that works on all devices
- ⚡ **Real-time Updates**: Automatic balance and lock status updates
- 🎨 **Modern UI**: Glassmorphism design with smooth animations

## Prerequisites

- Node.js 18+ 
- Solana wallet (Phantom, Solflare, etc.)
- Solana devnet SOL for testing

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create environment file**:
   Create `.env.local` in the frontend directory:
   ```env
   NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
   NEXT_PUBLIC_PROGRAM_ID=GSkBEUdNJCrVP7TyXWxWTCyeCACCXAKPN5gQMFWKgxic
   NEXT_PUBLIC_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
   NEXT_PUBLIC_USDC_FAUCET_URL=https://faucet.circle.com/devnet
   ```

3. **Run development server**:
   ```bash
   npm run dev
   ```

4. **Open browser**: Navigate to `http://localhost:3000`

## Usage

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

## Troubleshooting

### Common Issues

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
- Wait a few minutes between airdrop attempts
- Use a different RPC endpoint if needed

### Performance Tips

- Use a reliable RPC endpoint for better performance
- Consider using a local Solana validator for development
- Monitor network congestion on devnet

## Development

### Project Structure
```
src/
├── app/                 # Next.js app router
├── components/          # React components
├── lib/                # Utility functions
└── idl/                # Anchor IDL files
```

### Key Components
- `TimeLockForm.tsx`: Main application component
- `WalletProviders.tsx`: Wallet connection setup
- `anchorClient.ts`: Anchor program client

### Styling
- **Tailwind CSS**: Utility-first CSS framework
- **Glassmorphism**: Modern UI design with transparency effects
- **Responsive**: Mobile-first design approach

## Deployment

### Build for Production
```bash
npm run build
npm start
```

### Environment Variables for Production
- Update RPC URL to mainnet-beta for production
- Use production program ID
- Set appropriate USDC mint address

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License.
