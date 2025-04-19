FROM rust:1.74

# Set up working directory
WORKDIR /app

# Install dependencies
RUN apt-get update && apt-get install -y pkg-config libssl-dev

# Clone the wallet daemon repo
RUN git clone https://github.com/enjin/wallet-daemon.git .

# Build the daemon
RUN cargo build --release

# Expose port
EXPOSE 8282

# Run the wallet daemon
CMD ["./target/release/enjin-wallet-daemon"]
