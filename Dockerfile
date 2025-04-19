FROM rust:1.74-bullseye

# Install necessary system packages
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    pkg-config \
    libssl-dev \
    libclang-dev \
    cmake \
    clang \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Set work directory
WORKDIR /app

# Clone Wallet Daemon repo
RUN git clone https://github.com/enjin/wallet-daemon .

# Build the wallet daemon binary
RUN cargo build --release

# Expose daemon port
EXPOSE 8282

# Run the daemon
CMD ["./target/release/enjin-wallet-daemon"]
