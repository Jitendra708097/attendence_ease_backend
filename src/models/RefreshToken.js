module.exports = (sequelize, DataTypes) => {
  const RefreshToken = sequelize.define(
    'RefreshToken',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      token_hash: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('active', 'used', 'revoked'),
        defaultValue: 'active',
      },
      device_id: DataTypes.STRING,
      expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    },
    {
      tableName: 'refresh_tokens',
      paranoid: true,
      underscored: true,
    }
  );

  RefreshToken.associate = (models) => {
    RefreshToken.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
  };

  return RefreshToken;
};
